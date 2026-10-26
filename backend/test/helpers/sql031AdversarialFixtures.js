// TEST ONLY. Importing this module opens no connections and starts no processes.
// Synthetic driver evidence below is explicitly a unit-test model, never child IPC evidence.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { createControlSqlRunner, AUTHORITIES } = require('../../services/supervision/sql031Transactions');
const { createDormantSql031Gate } = require('../../services/supervision/sql031GateIntegration');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ fail, hold, identity = {}, connection = {}, runnerOptions = {}, requiredCapabilities = ['listener'], count = 2, unbound = false } = {}) {
  const supervisor = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), protocol_version: 1,
    process_id: 42, origin: 'local-parent-v1' };
  const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
    supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 43,
    session_challenge: 'c'.repeat(64), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
    observed_at: '2026-10-23T00:00:00.000Z', started_at: '2026-10-23T00:00:00.000Z' };
  const database = 'test_sql031_' + 'b'.repeat(32), schema = 'test_' + 'a'.repeat(32);
  const queries = [], commits = [], receipts = [], releases = [];
  const stops = [], proofs = [];
  let rows = [];
  let txBefore;
  let connects = 0, current, registered = false, born = false, gate = null;
  const client = { connectionParameters: { host: '127.0.0.1', database, user: 'test_issuer', query_timeout: 0, ...connection },
    release: broken => releases.push(broken), async query(sql, values) {
      queries.push({ sql, values });
      await hold?.(sql, values, current);
      const error = fail?.(sql, values, current); if (error) throw error;
      if (sql.startsWith('BEGIN')) { txBefore = { registered, born, gate, receipts: receipts.length, proofs: proofs.length }; current = null; return { command: 'BEGIN', rows: [] }; }
      if (sql === 'ROLLBACK') { ({ registered, born, gate } = txBefore); receipts.length = txBefore.receipts; proofs.length = txBefore.proofs; return { command: 'ROLLBACK', rows: [] }; }
      if (sql === 'COMMIT') { commits.push(current); if (current && typeof current === 'object') stops.push(current.execution_id); return { command: 'COMMIT', rows: [] }; }
      if (sql.startsWith('SELECT session_user')) return { rows: [{ session_user: 'test_issuer', current_user: 'test_issuer', database_name: database,
        rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
        owns_schema: false, schema_create: false, owns_database: false, ledger_write: false,
        migrator_member: false, executor_member: false, ...identity }] };
      if (sql.includes('.studiofy_register_supervisor(')) {
        current = 'supervisor'; registered = true; return { rows: [{ id: JSON.parse(values[0]).supervisor_id }] };
      }
      if (sql.includes('.studiofy_register_executor_birth(')) {
        assert.equal(registered, true); current = 'birth'; born = true; gate = 'BOOTSTRAPPING';
        return { rows: [{ id: JSON.parse(values[0]).executor_id }] };
      }
      if (sql.includes('.studiofy_advance_executor_gate(')) {
        assert.equal(born, true); assert.deepEqual(values.slice(0, 3), [birth.executor_id, birth.boot_id, supervisor.supervisor_id]);
        const next = values[3]; assert.equal(next === 'OPEN' ? gate === 'BOOTSTRAPPING' : next === 'DRAINING' && gate === 'OPEN', true);
        gate = next; current = next; return { rows: [{ state: next }] };
      }
      if (sql.includes('.studiofy_accept_executor_closure(')) {
        assert.equal(gate, 'DRAINING'); current = 'closure'; const v = JSON.parse(values[0]);
        assert.equal(v.evidence.admission_closed, true); assert.equal(v.evidence.scope_closed, true);
        for (const k of ['active_tasks', 'active_descendants', 'active_transports', 'pending_callbacks', 'pending_correlations', 'pending_sql', 'unresolved_sql']) assert.equal(v.evidence[k], 0);
        receipts.push({ closure_event_id: v.closure_event_id, proof_type: v.proof_type, protocol_version: v.protocol_version,
          executor_id: v.executor_id, boot_id: v.boot_id, supervisor_id: v.supervisor_id, supervisor_boot_id: v.supervisor_boot_id,
          evidence_canonicalization_version: 'pg-jsonb-v1', evidence_hash: 'sha256:' + 'd'.repeat(64) });
        gate = 'CLOSED'; return { rows: [{ id: v.closure_event_id }] };
      }
      if (sql.includes('.evolution_executor_closure_events WHERE')) return { rows: [receipts.at(-1)] };
      if (sql.startsWith('SELECT b.executor_id')) return { rows: unbound ? [] : [{ executor_id: birth.executor_id }] };
      if (sql.startsWith('SELECT e.execution_id')) return { rows: rows.filter(r => !values[3] || r.execution_id > values[3]).slice(0, values[4]) };
      if (sql.includes('.studiofy_accept_execution_stop(')) {
        current = JSON.parse(values[0]); proofs.push(current);
        return { rows: [{ id: current.proof_id }] };
      }
      assert.fail('Unexpected SQL: ' + sql);
    } };
  const options = { pool: { async connect() { connects++; return client; } }, authority: AUTHORITIES.SUPERVISOR_PROOF_ISSUER,
    issuerLogin: 'test_issuer', migratorLogin: 'test_migrator', executorLogin: 'test_executor', schema, database, localTestOnly: true, ...runnerOptions };
  const runner = createControlSqlRunner(options);
  rows = Array.from({ length: count }, (_, i) => ({ execution_id: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'),
    executor_id: birth.executor_id, boot_id: birth.boot_id, source_schema: schema, assinatura_id: '980001',
    instance_name: 'sql031-stop-synthetic', operation_kind: 'whatsapp_messages', delivery_id: String(i + 1),
    claim_token: randomUUID(), operation_token_fingerprint: 'sha256:' + 'e'.repeat(64) }));
  const input = { transactionRunner: runner, supervisor, birth, requiredCapabilities };
  const control = createDormantSql031Gate(input);
  return { control, stops, proofs, rows, receipts, executor: control.executor, runner, input, queries, commits, releases,
    connects: () => connects, sqlGate: () => gate };
}
const ready = async f => {
  f.executor.registerCapability('listener', () => {});
  assert.equal((await f.control.bootstrap()).outcome, 'CONFIRMED');
  assert.equal((await f.control.open()).outcome, 'CONFIRMED');
};

const { createSql031Authority } = require('../../services/supervision/sql031Authority');
const { createDormantSql031StopProjection } = require('../../services/supervision/sql031StopIntegration');
const closed = async f => { await ready(f); assert.equal((await f.control.close()).outcome, 'CONFIRMED'); return f.control.createStopProjection(); };
const proofQueries = f => f.queries.filter(q => q.sql.includes('.studiofy_accept_execution_stop('));


async function postgresFixture(t) {
  const { Pool } = require('pg');
  const { migrate } = require('../../database/migrate');
  const p = require('../../services/supervision/sql031Payloads');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.match(url.pathname, /^\/test_[a-zA-Z0-9_]+$/, 'Explicit local test database required');
  assert.equal(url.search, '', 'Connection overrides are forbidden');
  assert.equal(url.hash, '');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Dedicated local test server required');
  const admin = new Pool({ connectionString: url.toString() }), suffix = randomUUID().replaceAll('-', '');
  const database = 'test_sql031_' + suffix, schema = 'test_' + suffix, s = '"' + schema + '"';
  const roles = { migrator: 'test_migrator_' + suffix, executor: 'test_executor_' + suffix, issuer: 'test_issuer_' + suffix, adversary: 'test_adversary_' + suffix };
  const pools = [], createdRoles = []; let createdDatabase = false;
  t.after(async () => {
    const errors = [];
    for (const pool of pools) { try { await pool.end(); } catch (e) { errors.push(e); } }
    if (createdDatabase) { try { await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)'); } catch (e) { errors.push(e); } }
    for (const role of [...createdRoles].reverse()) { try { await admin.query('DROP ROLE "' + role + '"'); } catch (e) { errors.push(e); } }
    try { await admin.end(); } catch (e) { errors.push(e); }
    if (errors.length) throw new AggregateError(errors, 'Isolated fixture teardown failed');
  });
  const passwords = {};
  for (const [kind, role] of Object.entries(roles)) {
    passwords[kind] = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'' + passwords[kind] + '\'');
    createdRoles.push(role);
  }
  await admin.query('CREATE DATABASE "' + database + '" OWNER "' + roles.migrator + '"'); createdDatabase = true;
  function poolFor(kind) {
    const pool = new Pool({ host: url.hostname, port: Number(url.port || 5432), database, user: roles[kind], password: passwords[kind], max: 6,
      options: '-c search_path=' + schema + ',public', query_timeout: 0 }); pools.push(pool); return pool;
  }
  const migrator = poolFor('migrator'), executor = poolFor('executor'), issuer = poolFor('issuer'), adversary = poolFor('adversary');
  await migrate(migrator, schema);
  await migrator.query(`GRANT USAGE ON SCHEMA ${s} TO "${roles.issuer}","${roles.executor}","${roles.adversary}"`);
  const ledger = ['evolution_supervisors', 'evolution_executor_birth_bindings', 'evolution_executor_gates',
    'evolution_executor_closure_events', 'evolution_execution_stop_proofs', 'evolution_execution_stops'];
  await migrator.query(`GRANT SELECT ON ${['evolution_executors', 'evolution_operation_executions', 'evolution_execution_authorizations', ...ledger,
    'evolution_execution_lifecycle_status'].map(x => s + '.' + x).join(',')} TO "${roles.issuer}","${roles.adversary}"`);
  for (const api of ['studiofy_register_supervisor', 'studiofy_register_executor_birth', 'studiofy_accept_executor_closure', 'studiofy_accept_execution_stop']) {
    await migrator.query(`GRANT EXECUTE ON FUNCTION ${s}.${api}(jsonb) TO "${roles.issuer}","${roles.adversary}"`);
  }
  await migrator.query(`GRANT EXECUTE ON FUNCTION ${s}.studiofy_advance_executor_gate(uuid,uuid,uuid,text) TO "${roles.issuer}","${roles.adversary}"`);
  function compose(pool = issuer, login = roles.issuer, extra = {}) {
    const runner = createControlSqlRunner({ pool, authority: 'SUPERVISOR_PROOF_ISSUER', issuerLogin: login,
      migratorLogin: login === roles.migrator ? decodeURIComponent(url.username) : roles.migrator,
      executorLogin: roles.executor, schema, database, localTestOnly: true });
    const identity = extra.identity || { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID() };
    return { runner, identity, authority: createSql031Authority({ transactionRunner: runner, issuerIdentity: identity }) };
  }
  const q = (sql, values) => migrator.query(sql, values);
  const proofSql = `SELECT ${s}.studiofy_accept_execution_stop($1::jsonb) AS id`;
  const ledgerCount = async name => (await q(`SELECT count(*)::int n FROM ${s}.${name}`)).rows[0].n;
  const lifecycle = async id => (await issuer.query(`SELECT * FROM ${s}.evolution_execution_lifecycle_status WHERE execution_id=$1`, [id])).rows[0];
  const snapshot = async () => {
    const result = {};
    for (const table of ['whatsapp_messages', 'appointment_reminders', 'evolution_instance_owners',
      'evolution_delivery_reconciliations', 'return_reminders', 'whatsapp_conversation_responses', 'evolution_operation_executions',
      'assinaturas', 'whatsapp_conversations', 'whatsapp_conversation_inbox']) {
      result[table] = (await q(`SELECT to_jsonb(x) AS row FROM ${s}.${table} x ORDER BY to_jsonb(x)::text`)).rows;
    }
    return result;
  };
  let tenant = 985100;
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const fault = { loseStage: null, loseAt: null, sql: [], stage: null, enabled: false, calls: 0, lost: 0, hold: null, holdAt: null, seen: null, queries: 0 };
  const injected = { async connect() {
    const raw = await issuer.connect(); let proof = false;
    return { connectionParameters: raw.connectionParameters, release: broken => raw.release(broken), async query(sql, values) {
      fault.queries++; fault.sql.push(sql);
      if (sql.startsWith('BEGIN')) fault.stage = null;
      for (const [needle, stage] of [['studiofy_register_supervisor(', 'supervisor'], ['studiofy_register_executor_birth(', 'birth'], ['studiofy_accept_executor_closure(', 'closure']]) if (sql.includes(needle)) fault.stage = stage;
      if (sql.includes('studiofy_advance_executor_gate(')) fault.stage = values[3];
      if (sql.includes('.studiofy_accept_execution_stop(')) {
        proof = true; fault.calls++;
        if (fault.hold && fault.calls === fault.holdAt) { fault.seen.resolve(); await fault.hold.promise; }
      }
      const result = await raw.query(sql, values);
      if (sql === 'COMMIT' && ((proof && (fault.enabled || fault.calls === fault.loseAt)) || (fault.loseStage && fault.stage === fault.loseStage))) {
        fault.loseStage = null; fault.loseAt = null;
        fault.lost++; fault.enabled = false;
        throw Object.assign(Error('Synthetic ACK loss after actual PostgreSQL COMMIT'), { code: '08006' });
      }
      return result;
    } };
  } };
  async function candidate(count = 2, pool = issuer, { close = true, open = true, conversationManaged = false } = {}) {
    const supervisor = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), protocol_version: 1,
      process_id: 801, origin: 'local-parent-v1' };
    const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
      supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 802,
      session_challenge: randomBytes(32).toString('hex'), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
      observed_at: '2026-10-23T00:00:00.000Z', started_at: '2026-10-23T00:00:00.000Z' };
    const runner = createControlSqlRunner({ pool, authority: 'SUPERVISOR_PROOF_ISSUER', issuerLogin: roles.issuer,
      migratorLogin: roles.migrator, executorLogin: roles.executor, schema, database, localTestOnly: true });
    const gate = createDormantSql031Gate({ transactionRunner: runner, supervisor, birth, requiredCapabilities: ['listener'] });
    gate.executor.registerCapability('listener', () => {});
    assert.throws(() => gate.createStopProjection());
    assert.equal((await gate.bootstrap()).outcome, 'CONFIRMED'); if (open) assert.equal((await gate.open()).outcome, 'CONFIRMED');
    const executions = [];
    for (let i = 0; i < count; i++) {
      const id = ++tenant, instance = 'sql031-stop-' + id, token = randomUUID(), claim = randomUUID(), execution = randomUUID();
      await q(`INSERT INTO ${s}.assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
        VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2)`, [id, instance]);
      await q(`UPDATE ${s}.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2`, [token, String(id)]);
      const delivery = (await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,claimed_at,conversation_managed)
        VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,$5,clock_timestamp(),$6) RETURNING id`, [id, instance, randomUUID(), claim, token, conversationManaged])).rows[0].id;
      await q(`INSERT INTO ${s}.evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token)
        VALUES($1,$2,$3,$4,$5,'whatsapp_messages',$6,$7)`, [execution, birth.executor_id, token, id, instance, delivery, claim]);
      // Simulate an ambiguous transport result locally, without any actual transport.
      await q(`UPDATE ${s}.whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1`, [delivery]);
      await q(`UPDATE ${s}.whatsapp_messages SET status='uncertain' WHERE id=$1`, [delivery]);
      await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,conversation_managed)
        VALUES($1,$2,'5511999990000',$3,'Synthetic pending outbox entry','pending',$4)`, [id, instance, randomUUID(), conversationManaged]);
      executions.push(execution);
    }
    const closure = close ? await gate.close() : null; if (close) assert.equal(closure.outcome, 'CONFIRMED');
    return { gate, runner, birth, supervisor, executions: executions.sort(), receipt: closure?.value };
  }
  const payloads = async f => {
    // Read-only independent authority for SQL-negative fixtures, never substituted into the runtime capability.
    const authority = compose(issuer, roles.issuer, { identity: { supervisor_id: f.supervisor.supervisor_id,
      supervisor_boot_id: f.supervisor.supervisor_boot_id } }).authority;
    const selected = await authority.listExecutionSubjects({ executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 100 });
    assert.equal(selected.outcome, 'CONFIRMED');
    return selected.value.map(subject => p.proof({ proof_id: randomUUID(), idempotency_key: randomUUID() }, subject, f.receipt));
  };

  async function significantBusiness(f) {
    // Existing schema only. Pending inputs have durable received_order and wait for this uncertain delivery.
    const rows = (await q(`SELECT e.execution_id,e.assinatura_id,e.instance_name,e.delivery_id,e.operation_token,e.claim_token,
      m.status,m.attempts,m.sent_at,o.instance_key,o.conversation_epoch
      FROM ${s}.evolution_operation_executions e JOIN ${s}.whatsapp_messages m ON m.id=e.delivery_id
      JOIN ${s}.evolution_instance_owners o ON o.owner_id=e.assinatura_id::text AND o.operation_token=e.operation_token
      WHERE e.execution_id=ANY($1::uuid[]) ORDER BY e.execution_id`, [f.executions])).rows;
    assert.equal(rows.length, f.executions.length);
    const linked = [];
    for (const row of rows) {
      assert.equal(row.status, 'uncertain'); assert.ok(row.attempts > 0); assert.equal(row.sent_at, null);
      const conversation = randomUUID(), reference = randomBytes(8).toString('hex'), question = randomUUID();
      const pending = (await q(`SELECT id FROM ${s}.whatsapp_messages WHERE assinatura_id=$1 AND status='pending' ORDER BY id`,
        [row.assinatura_id])).rows;
      assert.equal(pending.length, 1);
      await q(`INSERT INTO ${s}.whatsapp_conversations(id,assinatura_id,instance_key,owner_epoch,sender,reference,last_response_id,question_id)
        VALUES($1,$2,$3,$4,'5511999990000',$5,$6,$7)`,
      [conversation, row.assinatura_id, row.instance_key, row.conversation_epoch, reference, row.delivery_id, question]);
      for (const delivery of [row.delivery_id, pending[0].id]) {
        await q(`INSERT INTO ${s}.whatsapp_conversation_responses(delivery_id,assinatura_id,conversation_id,owner_epoch,reference,question_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [delivery, row.assinatura_id, conversation, row.conversation_epoch, reference, question]);
      }
      const receipt = 'synthetic-disposition-' + randomUUID();
      await q(`INSERT INTO ${s}.evolution_delivery_reconciliations(receipt_key,operation_token,delivery_kind,delivery_id,assinatura_id,
        claim_token,outcome,instance_name,previous_last_error) VALUES($1,$2,'whatsapp_messages',$3,$4,$5,'abandoned_unknown',$6,$7)`,
      [receipt, row.operation_token, row.delivery_id, row.assinatura_id, row.claim_token, row.instance_name, 'Synthetic unresolved transport']);
      const order = [];
      for (let index = 0; index < 2; index++) {
        const inbound = (await q(`INSERT INTO ${s}.whatsapp_conversation_inbox(instance_key,message_id,assinatura_id,owner_epoch,
          fingerprint,decision,sender,conversation_id,expected_version,expected_reference,expected_response_id,expected_step,pending_event,pending_at)
          VALUES($1,$2,$3,$4,$5,'awaiting_delivery','5511999990000',$6,0,$7,$8,'MENU',$9::jsonb,clock_timestamp())
          RETURNING received_order`, [row.instance_key, randomUUID(), row.assinatura_id, row.conversation_epoch,
          randomBytes(32).toString('hex'), conversation, reference, row.delivery_id, JSON.stringify({ synthetic: true, index })])).rows[0];
        order.push(inbound.received_order);
      }
      assert.ok(BigInt(order[0]) < BigInt(order[1]));
      linked.push({ ...row, conversation, pending_delivery: pending[0].id, receipt, order });
    }
    return linked;
  }


  for (const [kind, pool] of [['migrator', migrator], ['executor', executor], ['issuer', issuer], ['adversary', adversary]]) {
    const row = (await pool.query('SELECT session_user,current_user')).rows[0];
    assert.equal(row.session_user, roles[kind]); assert.equal(row.current_user, roles[kind]);
  }
  const membership = async (from, to, enabled) => {
    assert.ok(createdRoles.includes(from) && createdRoles.includes(to));
    assert.equal(typeof enabled, 'boolean');
    await admin.query(enabled ? `GRANT "${from}" TO "${to}"` : `REVOKE "${from}" FROM "${to}"`);
  };
  return { roles, schema, database, s, q, executor, issuer, adversary, migrator, compose, candidate, membership,
    payloads, significantBusiness, snapshot, lifecycle, ledgerCount, ledger, proofSql, fault, injected };
}
function observeChild(s, report = () => {}, injectedMessages = new WeakSet()) {
  const wire = [];
  const record = (direction, message) => {
    const origin = direction === 'parent-to-child' ? 'supervisor' :
      injectedMessages.has(message) ? 'test-adversarial-input' : 'child-ipc';
    const observation = { direction, origin, type: message?.message_type, sequence: message?.sequence };
    wire.push(observation); report(observation);
  };
  const send = s.child.send;
  s.child.send = function(message, ...args) { record('parent-to-child', message); return send.call(this, message, ...args); };
  s.child.on('message', message => record('child-to-parent', message));
  return wire;
}
function assertObservedExit(f) {
  const spawn = f.events.find(e => e.type === 'spawn'), ready = f.events.find(e => e.type === 'ready');
  const exit = f.events.find(e => e.type === 'exit');
  assert.ok(spawn && ready && exit); assert.equal(spawn.pid, f.s.child.pid); assert.equal(exit.pid, spawn.pid);
  assert.deepEqual(f.s.snapshot().exit, { pid: exit.pid, spawn_id: exit.spawn_id, code: exit.code, signal: exit.signal });
  assert.ok(f.calls.some(call => call.kind === 'birth')); assert.ok(f.calls.some(call => call.kind === 'open'));
  assert.ok(f.wire.some(m => m.direction === 'child-to-parent' && m.type === 'READY'));
  assert.ok(f.wire.some(m => m.direction === 'parent-to-child' && m.type === 'ACK'));
  assert.equal(f.wire.some(m => ['STOPPED', 'SQL031_CLOSURE', 'EXECUTION_STOP'].includes(m.type) &&
    (m.direction === 'parent-to-child' || m.origin !== 'test-adversarial-input')), false);
  assert.equal(f.calls.includes('FORBIDDEN_PROOF'), false);
  // Actual process/IPC observations only. No SQL persistence seam exists in this supervisor.
}
function processFixture(t, options = {}) {
  const { startSupervisor } = require('../../supervisor');
  const calls = [], events = [], waiters = new Set();
  let output = '';
  const noProof = () => { calls.push('FORBIDDEN_PROOF'); throw Error('No proof authority in process fixture'); };
  const s = startSupervisor({ environment: { NODE_ENV: 'test', PORT: '0', ...options.environment },
    heartbeatMs: 50, heartbeatTimeoutMs: 800, handshakeTimeoutMs: 5000,
    authority: { localTestOnly: true, enrollBirth: async record => { calls.push({ kind: 'birth', record }); },
      openGate: async () => { calls.push({ kind: 'open' }); }, beginDraining: async () => { calls.push({ kind: 'drain' }); },
      acceptCooperativeClosure: noProof, acceptExecutionStop: noProof, ...options.authority },
    onEvent: e => { events.push(e); for (const wake of waiters) wake(); } });
  const injectedMessages = new WeakSet(), adversarialInputs = [];
  const wire = observeChild(s, observation => {
    if (observation.origin === 'test-adversarial-input') adversarialInputs.push(observation);
  }, injectedMessages);
  const injectAdversarialMessage = message => {
    assert.ok(message && typeof message === 'object');
    // Provenance belongs to this harness, never to a caller-supplied origin field.
    injectedMessages.add(message);
    try { assert.equal(s.child.emit('message', message), true); }
    finally { injectedMessages.delete(message); }
  };
  s.child.stdout.on('data', b => { output += b; }); s.child.stderr.on('data', b => { output += b; });
  const event = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(Error('Missing process event ' + type)); }, 10000);
    const check = () => { const e = events.find(e => e.type === type); if (e) { clearTimeout(timer); waiters.delete(check); resolve(e); } };
    waiters.add(check); check();
  });
  t.after(async () => { s.shutdown(); await s.done; });
  return { s, calls, events, wire, adversarialInputs, injectAdversarialMessage, event, output: () => output };
}

function signalParent(t) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [__filename, 'signal-parent'], { env: { NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; const waiters = new Set();
  const done = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  child.stdout.on('data', b => { output += b; for (const check of waiters) check(); });
  child.stderr.on('data', b => { output += b; });
  const event = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(Error('Missing parent event ' + type + ': ' + output)); }, 12000);
    const check = () => { const line = output.split('\n').find(l => l.startsWith('PARENT ') && JSON.parse(l.slice(7)).type === type);
      if (line) { clearTimeout(timer); waiters.delete(check); resolve(JSON.parse(line.slice(7))); } };
    waiters.add(check); check();
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return { child, done, event, output: () => output };
}

module.exports = { fixture, ready, closed, deferred, proofQueries, postgresFixture, processFixture, signalParent, assertObservedExit };

// Explicit child entrypoint used only by the separate Linux test. Importing is inert.
if (require.main === module) {
  assert.equal(process.argv[2], 'signal-parent'); assert.equal(process.env.NODE_ENV, 'test');
  const { startSupervisor } = require('../../supervisor');
  const s = startSupervisor({ environment: { NODE_ENV: 'test' },
    authority: { localTestOnly: true, enrollBirth: async () => {}, openGate: async () => {}, beginDraining: async () => {} },
    onEvent: event => console.log('PARENT ' + JSON.stringify(event)) });
  observeChild(s, observation => console.log('WIRE ' + JSON.stringify(observation)));
  s.child.stdout.pipe(process.stdout); s.child.stderr.pipe(process.stderr);
  s.done.then(result => console.log('DONE ' + JSON.stringify(result)));
}
