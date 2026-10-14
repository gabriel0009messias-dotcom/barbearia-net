const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');
const { transitionAppointment } = require('../services/agenda');
const { createReturnReminderWorker, startWorker, inProcessingWindow, LEASE_MS, INTERVAL_MS } = require('../services/returnReminders');
const { createSimulatedDispatcher, composeMessage } = require('../services/returnReminderDispatcher');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { const result = await check(); if (result) return result; await sleep(10); }
  throw new Error('Condition did not become true');
}

test('return worker: business window is São Paulo, 09:00 inclusive / 18:00 exclusive', () => {
  for (const [utc, allowed] of [['11:59:59.999', false], ['12:00:00.000', true], ['16:30:00.000', true],
    ['20:59:59.999', true], ['21:00:00.000', false], ['22:00:00.000', false]]) {
    assert.equal(inProcessingWindow(new Date('2030-06-03T' + utc + 'Z')), allowed, utc);
  }
  assert.equal(inProcessingWindow(new Date('2030-06-04T12:00:00Z')), true);
  assert.equal(LEASE_MS, 120000); assert.equal(INTERVAL_MS, 60000);
});

test('return worker: only branded local simulations are accepted; message preserves every snapshot', async () => {
  assert.throws(() => createReturnReminderWorker({}, { dispatcher: { mode: 'simulated', dispatch() {} } }));
  assert.throws(() => createSimulatedDispatcher({ outcome: 'evolution' }));
  for (const service of ['Unha em gel', 'Design de sobrancelha', 'Massagem', 'Corte Degradê', 'Serviço futuro 🧡']) {
    assert.equal(composeMessage({ customer_name_snapshot: 'Ágata', service_name_snapshot: service }),
      `Olá, Ágata! 👋 Já se passaram 7 dias desde o seu atendimento de ${service}. Que tal agendar novamente?`);
  }
});

test('return worker: actual server opt-in starts once and signal shutdown stops it and exits', { timeout: 30000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  t.after(() => env.cleanup());
  for (const mode of ['', 'simulated']) {
    const reservation = require('node:net').createServer();
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const code = `const mod=require('./services/returnReminders');let started=0,stopped=0;
      const original=mod.startWorker;mod.startWorker=(...args)=>{started++;const handle=original(...args),stop=handle.stop;
        handle.stop=async()=>{await stop();stopped++;};return handle;};
      process.on('message',message=>{if(message==='report')process.send({started});
        if(message==='shutdown'){process.emit('SIGTERM');const timer=setInterval(()=>{
          if(stopped===started){clearInterval(timer);process.disconnect();}},10);}});
      require('./app');`;
    const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), windowsHide: true,
      env: { ...process.env, PORT: String(port), RETURN_REMINDER_WORKER_MODE: mode,
        EVOLUTION_API_URL: '', EVOLUTION_API_KEY: '', MERCADO_PAGO_ACCESS_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
    await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', code => reject(Error('Server exited before startup: ' + code)));
      child.stdout.on('data', data => { if (String(data).includes('Servidor rodando na porta')) resolve(); });
    });
    const report = new Promise(resolve => child.once('message', resolve)); child.send('report');
    assert.equal((await report).started, mode ? 1 : 0);
    child.send('shutdown'); assert.equal(await exited, 0);
  }
});

test('return worker: durable claims, restart, concurrency, snapshots and local outcomes', { timeout: 90000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database'); await db.ready;
  const real = '"' + env.schema + '"';
  const otherPool = new Pool(require('../database/config').connectionConfig());
  const secondInstance = { pool: otherPool, ready: Promise.resolve() };
  t.after(async () => { await otherPool.end(); await db.close(); await env.cleanup(); });
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, level, (...args) => logs.push(args));
  let network = 0;
  t.mock.method(global, 'fetch', async () => { network++; throw Error('Network forbidden'); });
  for (const id of [6, 806]) await db.runAsync(`INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,
    metodo_pagamento,dia_vencimento,suporte_numero,acesso_manual_ate,public_slug)
    VALUES ($1,'Synthetic studio','Synthetic owner','11988886060','mercado_pago',5,'11977776060','2099-01-01',$2)`, [id, 'test-studio-' + id]);
  const row = async id => db.getAsync('SELECT * FROM return_reminders WHERE id=$1', [id]);
  let now = new Date('2030-06-03T15:00:00Z');
  const worker = (options = {}, instance = db) => createReturnReminderWorker(instance, { schema: env.schema, clock: () => now, ...options });
  const group = (c, r) => c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
  const service = async (tenant = 6, name = 'Serviço livre') => (await db.runAsync('INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES ($1,$2,30)', [tenant, name])).lastID;
  const book = async (sid, tenant = 6) => (await db.runAsync(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,
    preco,data,hora,status,studio_service_id) VALUES ($1,'Ágata histórica','11999996060','Snapshot original',30,'2020-01-01','10:00','confirmado',$2)`, [tenant, sid])).lastID;
  const complete = async (sid, tenant = 6) => {
    const appointment = await book(sid, tenant); await transitionAppointment(db, tenant, appointment, 'concluido');
    return db.getAsync('SELECT * FROM return_reminders WHERE appointment_id=$1', [appointment]);
  };
  const opportunity = async (tenant = 6, name) => complete(await service(tenant, name), tenant);
  const state = async (r, status, { dispatch = false, expired = false, token = randomUUID(), attempts = 1 } = {}) => {
    await db.transaction(async c => { await group(c, r); await c.runAsync(`UPDATE return_reminders SET status=$2,
      claim_token=$3,claimed_at=$4,lease_until=$5,dispatch_started_at=$6,attempts=$7 WHERE id=$1`,
    [r.id, status, token, now, new Date(+now + (expired ? -1000 : LEASE_MS)), dispatch ? now : null, attempts]); }, { serialize: false });
    return row(r.id);
  };
  const drainOne = async r => { await worker().drain(); return row(r.id); };
  const killSession = async r => {
    const owner = await db.getAsync(`SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted AND objsubid=1
      AND classid::bigint=((${real}.studiofy_return_group_key($1,$2,$3) >> 32) & 4294967295::bigint)
      AND objid::bigint=(${real}.studiofy_return_group_key($1,$2,$3) & 4294967295::bigint) LIMIT 1`,
    [r.assinatura_id, r.customer_key, r.service_identity]);
    assert.ok(owner); await db.getAsync('SELECT pg_terminate_backend($1)', [owner.pid]);
  };

  await t.test('not seven days: no claim, attempt, intent or send; exact eligibility respects the window', async () => {
    const r = await opportunity(); now = new Date(+r.eligible_at - 1);
    assert.deepEqual(await drainOne(r), r);
    now = (await db.getAsync('SELECT eligible_at::text AS exact FROM return_reminders WHERE id=$1', [r.id])).exact;
    const atBoundary = await drainOne(r);
    assert.equal(atBoundary.status, inProcessingWindow(now) ? 'sent' : 'pending');
    if (atBoundary.status === 'pending') { now = new Date('2030-06-03T15:00:00Z'); assert.equal((await drainOne(r)).status, 'sent'); }
  });
  await t.test('before 09:00, 09:00, during window, 18:00, after 18:00 and next window never change eligible_at', async () => {
    for (const time of ['11:59:59.999', '12:00:00.000', '16:00:00.000', '21:00:00.000', '22:00:00.000']) {
      const r = await opportunity(); now = new Date('2030-06-03T' + time + 'Z');
      const after = await drainOne(r); assert.equal(after.status, inProcessingWindow(now) ? 'sent' : 'pending');
      assert.deepEqual(after.eligible_at, r.eligible_at);
      if (after.status === 'pending') { now = new Date('2030-06-04T12:00:00Z'); assert.equal((await drainOne(r)).status, 'sent'); }
    }
  });
  await t.test('success stores simulated evidence, preserves snapshots after catalog rename and is idempotent', async () => {
    now = new Date('2030-06-03T15:00:00Z'); const r = await opportunity();
    await db.runAsync("UPDATE servicos_assinatura SET nome='Nome atual diferente' WHERE id=$1", [r.service_identity.slice(8)]);
    const sent = await drainOne(r); assert.equal(sent.status, 'sent'); assert.equal(sent.attempts, 1);
    assert.match(sent.provider_message_id, /^simulated:/); assert.ok(sent.dispatch_started_at); assert.ok(sent.sent_at);
    assert.equal(sent.service_name_snapshot, 'Snapshot original'); assert.equal(sent.claim_token, null); assert.equal(sent.lease_until, null);
    assert.deepEqual(await drainOne(r), sent);
  });
  await t.test('two workers / separate application pools cannot dispatch one reminder twice', async () => {
    const r = await opportunity(), dispatcher = createSimulatedDispatcher({ outcome: 'paused_success' });
    const one = worker({ dispatcher });
    const two = worker({}, secondInstance);
    const first = one.drain(); await until(async () => (await row(r.id)).dispatch_started_at);
    try { await two.drain(); } finally { dispatcher.release(); }
    await first;
    const sent = await row(r.id); assert.equal(sent.status, 'sent'); assert.equal(sent.attempts, 1);
  });
  await t.test('two independent Node processes share claims and do not duplicate', async () => {
    const r = await opportunity();
    const code = `const db=require('./database'); const {createReturnReminderWorker}=require('./services/returnReminders');
      const {createSimulatedDispatcher}=require('./services/returnReminderDispatcher');
      (async()=>{await db.ready;await createReturnReminderWorker(db,{clock:()=>new Date('2030-06-03T15:00:00Z'),
      dispatcher:createSimulatedDispatcher({delayMs:100})}).drain();await db.close();})().catch(()=>process.exitCode=1);`;
    const runChild = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error('Worker child failed')));
    });
    await Promise.all([runChild(), runChild()]); const sent = await row(r.id);
    assert.equal(sent.status, 'sent'); assert.equal(sent.attempts, 1);
  });
  await t.test('valid lease is retained; expired pre-intent lease gets a new token after restart', async () => {
    const r = await opportunity(), held = await state(r, 'processing');
    assert.deepEqual(await drainOne(r), held);
    now = new Date(+now + LEASE_MS + 1);
    const sent = await drainOne(r); assert.equal(sent.status, 'sent'); assert.equal(sent.attempts, 2);
    assert.notEqual(sent.claimed_at.getTime(), held.claimed_at.getTime()); assert.equal(sent.claim_token, null);
  });
  await t.test('restart with expired durable dispatch intent becomes uncertain even outside the window', async () => {
    const r = await opportunity(); await state(r, 'processing', { dispatch: true, expired: true });
    now = new Date('2030-06-03T22:00:00Z'); const recovered = await drainOne(r);
    assert.equal(recovered.status, 'uncertain'); assert.equal(recovered.reason_code, 'delivery_uncertain');
    assert.equal(recovered.claim_token, null); assert.equal(recovered.attempts, 1);
    now = new Date('2030-06-04T12:00:00Z'); assert.deepEqual(await drainOne(r), recovered);
  });
  await t.test('old worker cannot finalize after its lease has expired; recovery never resends after intent', async () => {
    const r = await opportunity(), dispatcher = createSimulatedDispatcher({ outcome: 'paused_success' }), old = worker({ dispatcher });
    const processing = old.drain(); await until(async () => (await row(r.id)).dispatch_started_at);
    now = new Date(+now + LEASE_MS + 1); dispatcher.release(); await processing;
    const abandoned = await row(r.id); assert.equal(abandoned.status, 'processing'); assert.equal(abandoned.sent_at, null);
    assert.equal((await drainOne(r)).status, 'uncertain');
  });
  await t.test('lost PostgreSQL session before intent: old worker fails, fresh lease/token recovers safely', async () => {
    const r = await opportunity(), blocker = await otherPool.connect();
    await blocker.query('BEGIN'); await blocker.query('LOCK TABLE servicos_assinatura IN ACCESS EXCLUSIVE MODE');
    const processing = worker().drain();
    // Attach a rejection handler before deliberately terminating its connection.
    const rejected = assert.rejects(processing);
    try {
      const claimed = await until(async () => { const current = await row(r.id); return current.status === 'processing' && current; });
      assert.equal(claimed.dispatch_started_at, null);
      await killSession(r); await rejected;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    now = new Date(+now + LEASE_MS + 1);
    const recovered = await drainOne(r); assert.equal(recovered.status, 'sent'); assert.equal(recovered.attempts, 2);
  });
  await t.test('lost PostgreSQL session after intent aborts simulation; restart produces uncertainty, never another dispatch', async () => {
    const r = await opportunity();
    const processing = worker({ dispatcher: createSimulatedDispatcher({ outcome: 'timeout' }) }).drain();
    await until(async () => (await row(r.id)).dispatch_started_at); await killSession(r); await processing;
    const abandoned = await row(r.id); assert.equal(abandoned.status, 'processing'); assert.equal(abandoned.sent_at, null);
    now = new Date(+now + LEASE_MS + 1); const recovered = await drainOne(r);
    assert.equal(recovered.status, 'uncertain'); assert.equal(recovered.attempts, 1);
    assert.deepEqual(await drainOne(r), recovered);
  });
  await t.test('pre-dispatch simulated failures retry only after next_attempt_at, then stop permanently', async () => {
    const r = await opportunity(); const failing = worker({ dispatcher: createSimulatedDispatcher({ outcome: 'before_dispatch_failure' }) });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await failing.drain(); const current = await row(r.id);
      assert.equal(current.attempts, attempt); assert.equal(current.dispatch_started_at, null);
      assert.equal(current.status, attempt === 3 ? 'failed' : 'pending');
      await failing.drain(); assert.deepEqual(await row(r.id), current);
      now = new Date(+now + 60000);
    }
    assert.equal((await drainOne(r)).status, 'failed');
  });
  for (const outcome of ['uncertain', 'timeout', 'rejected']) await t.test('post-intent simulation: ' + outcome + ' is terminal, never retried', async () => {
    const r = await opportunity(); await worker({ dispatcher: createSimulatedDispatcher({ outcome }), dispatchTimeoutMs: 20 }).drain();
    const terminal = await row(r.id); assert.equal(terminal.status, outcome === 'rejected' ? 'failed' : 'uncertain');
    assert.ok(terminal.dispatch_started_at); assert.equal(terminal.attempts, 1); assert.equal(terminal.sent_at, null);
    now = new Date(+now + LEASE_MS * 2); assert.deepEqual(await drainOne(r), terminal);
  });
  for (const terminal of ['suppressed', 'sent', 'uncertain', 'failed', 'cancelled']) await t.test('never reopens existing ' + terminal, async () => {
    const r = await opportunity(), before = await state(r, terminal);
    assert.deepEqual(await drainOne(r), before);
  });
  await t.test('same phone in A/B, same names with different service identities and all segments are independent', async () => {
    const records = [];
    for (const name of ['Unha em gel', 'Design de sobrancelha', 'Massagem', 'Corte Degradê', 'Serviço futuro 🧡']) {
      records.push(await opportunity(6, name)); records.push(await opportunity(806, name));
    }
    assert.equal(records[0].phone_snapshot, records[1].phone_snapshot); assert.notEqual(records[0].customer_key, records[1].customer_key);
    await worker().drain();
    for (const r of records) { const sent = await row(r.id); assert.equal(sent.status, 'sent'); assert.equal(sent.assinatura_id, r.assinatura_id); assert.equal(sent.attempts, 1); }
  });
  await t.test('new completion before intent suppresses the old claim and never dispatches it', async () => {
    const sid = await service(), old = await complete(sid); await state(old, 'processing', { expired: true });
    const newer = await complete(sid); await worker().drain();
    assert.equal((await row(old.id)).status, 'suppressed'); assert.equal((await row(old.id)).dispatch_started_at, null);
    assert.equal((await row(newer.id)).status, 'sent');
  });
  await t.test('concurrent newer completion waits for session lock through durable dispatch and result', async () => {
    const sid = await service(), old = await complete(sid), appointment = await book(sid);
    const dispatcher = createSimulatedDispatcher({ outcome: 'paused_success' });
    const processing = worker({ dispatcher }).drain();
    await until(async () => (await row(old.id)).dispatch_started_at);
    let completed = false;
    const finishing = transitionAppointment(db, 6, appointment, 'concluido').then(() => { completed = true; });
    try {
      await until(async () => (await db.getAsync(`SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory'
        AND NOT granted AND objsubid=1 AND classid::bigint=((studiofy_return_group_key($1,$2,$3) >> 32) & 4294967295::bigint)
        AND objid::bigint=(studiofy_return_group_key($1,$2,$3) & 4294967295::bigint)`,
      [old.assinatura_id, old.customer_key, old.service_identity])).n > 0);
      assert.equal(completed, false);
    } finally { dispatcher.release(); }
    await processing; await finishing;
    assert.equal((await row(old.id)).status, 'sent');
    const newer = await db.getAsync('SELECT * FROM return_reminders WHERE appointment_id=$1', [appointment]);
    assert.equal(newer.status, 'pending');
    assert.equal((await drainOne(newer)).status, 'sent');
  });
  await t.test('unavailable tenant or inactive service cancels without dispatch', async () => {
    const r = await opportunity(); await db.runAsync('UPDATE servicos_assinatura SET ativo=false WHERE id=$1', [r.service_identity.slice(8)]);
    const canceled = await drainOne(r); assert.equal(canceled.status, 'cancelled'); assert.equal(canceled.reason_code, 'unavailable_service'); assert.equal(canceled.dispatch_started_at, null);
    const b = await opportunity(806); await db.runAsync('UPDATE assinaturas SET bloqueio_admin=true WHERE id=806');
    const blocked = await drainOne(b); assert.equal(blocked.status, 'cancelled'); assert.equal(blocked.reason_code, 'account_unavailable'); assert.equal(blocked.dispatch_started_at, null);
    await db.runAsync('UPDATE assinaturas SET bloqueio_admin=false WHERE id=806');
  });
  await t.test('shutdown aborts local timeout, persists uncertainty, releases the group and permits clean restart', async () => {
    const r = await opportunity(), instance = worker({ dispatcher: createSimulatedDispatcher({ outcome: 'timeout' }) });
    const processing = instance.drain(); await until(async () => (await row(r.id)).dispatch_started_at);
    await instance.stop(); await processing; assert.equal((await row(r.id)).status, 'uncertain');
    assert.deepEqual(await instance.drain(), []); assert.equal((await drainOne(r)).status, 'uncertain');
  });
  await t.test('module reload/start calls share one timer per database; stopping permits a new start', async () => {
    const options = { schema: env.schema, clock: () => now };
    const first = startWorker(db, options); assert.equal(startWorker(db, options), first);
    delete require.cache[require.resolve('../services/returnReminders')];
    assert.equal(require('../services/returnReminders').startWorker(db, options), first);
    await first.stop(); const second = startWorker(db, options); assert.notEqual(second, first); await second.stop();
  });
  await t.test('M-RETORNO-04 worker ignores shadow relations and a changed caller search_path', async () => {
    const r = await opportunity(), pool = new Pool({ ...require('../database/config').connectionConfig(), max: 1 });
    const c = await pool.connect();
    await c.query('CREATE TEMP TABLE return_reminders (id bigint)'); await c.query('SET search_path TO pg_temp,public'); c.release();
    try { await worker({}, { pool, ready: Promise.resolve() }).drain(); assert.equal((await row(r.id)).status, 'sent'); }
    finally { await pool.end(); }
  });
  await t.test('only safe generic logs; no network or private payload logging', () => { assert.equal(network, 0); assert.deepEqual(logs, []); });
});
