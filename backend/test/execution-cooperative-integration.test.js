const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { Pool } = require('pg');
const { createExecutionScope } = require('../services/executionScope');
const { createCapabilityCoordinator } = require('../services/executionCapabilities');
const { createSqlAccounting } = require('../services/executionSql');

test('dormant seal leaves real SQL fixture deliveries, reservations and proof tables intact', async t => {
  const env = require('./helpers/postgres').testEnvironment(), db = require('../database');
  await db.ready; t.after(async () => { await db.close(); await env.cleanup(); });
  const token = randomUUID(), instance = 'cooperative-synthetic-' + randomUUID();
  await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES(95001,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$1,'ativo','2099-01-01')", [instance]);
  await db.runAsync("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='95001'", [token]);
  await db.runAsync("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,attempts,sent_at,operation_token,claim_token,dispatch_started_at) VALUES(37,95001,$1,'5511999990001','synthetic-37','Synthetic','uncertain',1,NULL,$2,$3,clock_timestamp()),(69,95001,$1,'5511999990002','synthetic-69','Synthetic','pending',0,NULL,NULL,$4,NULL)", [instance,token,randomUUID(),randomUUID()]);
  const tables = ['whatsapp_messages','evolution_instance_owners','evolution_supervisors','evolution_executor_birth_bindings',
    'evolution_executor_gates','evolution_executor_closure_events','evolution_execution_stop_proofs','evolution_execution_stops',
    'evolution_delivery_reconciliations','evolution_operation_executions'];
  const snapshot = async () => {
    const result = {};
    for (const table of tables) result[table] = await db.allAsync('SELECT * FROM ' + table);
    return result;
  };
  const before = await snapshot();
  const scope = createExecutionScope({ certifiable: true }); scope.setExecutor({ executorId: randomUUID(), bootId: randomUUID() });
  const raw = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: '-c search_path=' + env.schema + ',public' });
  try {
    const pool = createSqlAccounting(scope).wrapPool(raw), coordinator = createCapabilityCoordinator(scope);
    let stale;
    await scope.admit('delivery.provider-correlation', async () => {
      stale = scope.bindCallback(() => pool.query('UPDATE whatsapp_messages SET attempts=attempts+1 WHERE id IN (37,69)'));
      assert.equal((await pool.query('SELECT attempts FROM whatsapp_messages WHERE id=37')).rows[0].attempts, '1');
    });
    await coordinator.drain(); const seal = coordinator.sealClosedScope(); assert.equal(scope.ownsSeal(seal), true);
    await assert.rejects(stale(), { code: 'INSTANCE_ADMISSION_CLOSED' });
    assert.deepEqual(await snapshot(), before);
    assert.equal(before.whatsapp_messages.find(row => row.id === 37).status, 'uncertain');
    assert.equal(before.whatsapp_messages.find(row => row.id === 69).attempts, 0);
    for (const table of tables.filter(name => /supervisors|birth|gates|closure|proof|stops/.test(name))) assert.deepEqual(before[table], []);
  } finally { await raw.end(); }
});

test('real application coordinator shuts workers and HTTP before a local seal; no automatic issuer', { timeout: 30000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  t.after(() => env.cleanup());
  const code = `
    process.env.PORT='0';
    const scope=require('./services/executionScope').executionScope;
    const coordinator=require('./services/executionCapabilities').coordinator;
    const log=console.log;
    console.log=(...args)=>{log(...args);if(String(args[0]).includes('Servidor rodando na porta')) {
      process.emit('SIGTERM');
      coordinator.drain().then(()=>{
        const seal=coordinator.sealClosedScope();
        log('COOPERATIVE_REPORT '+JSON.stringify({sealed:scope.ownsSeal(seal),snapshot:scope.snapshot(),emission:coordinator.persistentEmissionEnabled}));
      }).catch(error=>{console.error(error);process.exitCode=1;});
    }};
    require('./app');`;
  const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 25000);
  const exit = await new Promise((resolve,reject) => { child.once('exit',resolve); child.once('error',reject); }); clearTimeout(timer);
  assert.equal(exit, 0, output.slice(-4000));
  const line = output.split(/\r?\n/).find(value => value.startsWith('COOPERATIVE_REPORT ')); assert.ok(line, output);
  const result = JSON.parse(line.slice('COOPERATIVE_REPORT '.length));
  assert.equal(result.sealed, true); assert.equal(result.emission, false);
  assert.equal(result.snapshot.state, 'CLOSED'); assert.deepEqual(result.snapshot.capabilities, []);
  assert.deepEqual(result.snapshot.obligations, []); assert.equal(result.snapshot.activeCount, 0);
});

test('real ownership context and queued heartbeat cannot renew or cross a boundary after sealing', { timeout: 30000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment(); t.after(() => env.cleanup());
  const code = `
    const assert=require('node:assert/strict'),pg=require('pg');
    let calls=0,heartbeat;
    const query=pg.Client.prototype.query;
    pg.Client.prototype.query=function(...args){calls++;return query.apply(this,args);};
    const interval=global.setInterval;
    global.setInterval=(callback,ms,...args)=>{if(ms===3000)heartbeat=callback;return interval(callback,ms,...args);};
    const scope=require('./services/executionScope').executionScope;
    scope.certifyProfile();
    const db=require('./database');
    (async()=>{
      await db.ready;
      await require('./services/executionLifecycle').initializeExecutor(db.pool);
      await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES(95002,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','cooperative-authority-synthetic','ativo','2099-01-01')");
      const operation=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(db.pool);
      let context;
      await operation.run(95002,async old=>{context=old;return 'synthetic';});
      assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_execution_stop_proofs')).n,0);
      assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_execution_stops')).n,0);
      await scope.drain();const seal=scope.sealClosedScope(),before=calls;
      assert.equal(typeof heartbeat,'function');heartbeat();
      await assert.rejects(context.authorizeEffect());
      await assert.rejects(operation.run(95002,()=>assert.fail('no new authority')));
      await assert.rejects(db.pool.query('SELECT 1'));
      assert.equal(calls,before);assert.equal(scope.ownsSeal(seal),true);
      await db.close();console.log('OWNERSHIP_SEAL_PASS');
    })().catch(error=>{console.error(error);process.exitCode=1;db.close().catch(()=>{});});`;
  const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill(), 25000);
  const exit = await new Promise((resolve,reject) => { child.once('exit',resolve); child.once('error',reject); }); clearTimeout(timer);
  assert.equal(exit, 0, output.slice(-4000)); assert.match(output, /OWNERSHIP_SEAL_PASS/);
});
