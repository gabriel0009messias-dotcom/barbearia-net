const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const p = require('../services/supervision/sql031Payloads');
const { AUTHORITIES, createControlSqlRunner } = require('../services/supervision/sql031Transactions');
const { createSql031Authority } = require('../services/supervision/sql031Authority');

const schema = 'test_' + 'a'.repeat(32), database = 'test_sql031_' + 'b'.repeat(32);
function inputs() {
  const supervisor = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), protocol_version: 1, process_id: 42, origin: 'local-parent-v1' };
  const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
    supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 43,
    session_challenge: 'c'.repeat(64), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
    observed_at: '2026-10-22T00:00:00.000Z', started_at: '2026-10-22T00:00:00.000Z' };
  const closure = { closure_event_id: randomUUID(), proof_type: 'COOPERATIVE_SCOPE_CLOSED', protocol_version: 1,
    executor_id: birth.executor_id, boot_id: birth.boot_id, supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id,
    origin: 'supervisor-ipc-v1', evidence_canonicalization_version: 'pg-jsonb-v1', observed_at: '2026-10-22T01:00:00.000Z', idempotency_key: randomUUID(),
    evidence: { seal_id: randomUUID(), admission_closed: true, scope_closed: true, active_tasks: 0, active_descendants: 0,
      active_transports: 0, pending_callbacks: 0, pending_correlations: 0, pending_sql: 0, unresolved_sql: 0, runtime_profile: birth.runtime_profile } };
  return { supervisor, birth, closure };
}
function peer({ fail, identity = {}, connection = {}, commitCommand = 'COMMIT' } = {}) {
  const x = inputs(), queries = [], releases = [], receipts = [];
  let connects = 0;
  const subject = { execution_id: randomUUID(), executor_id: x.birth.executor_id, boot_id: x.birth.boot_id,
    source_schema: schema, assinatura_id: '9007199254740993', instance_name: 'synthetic', operation_kind: 'instance_operation',
    delivery_id: null, claim_token: null, operation_token_fingerprint: 'sha256:' + 'd'.repeat(64) };
  const client = { connectionParameters: { host: '127.0.0.1', database, user: 'test_issuer', query_timeout: 0, ...connection },
    release: broken => releases.push(broken), async query(sql, values) {
      queries.push({ sql, values });
      const error = fail?.(sql, values); if (error) throw error;
      if (sql.startsWith('SELECT session_user')) return { rows: [{ session_user: 'test_issuer', current_user: 'test_issuer', database_name: database,
        rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
        owns_schema: false, schema_create: false, owns_database: false, ledger_write: false,
        migrator_member: false, executor_member: false, ...identity }] };
      if (sql === 'COMMIT') return { rows: [], command: commitCommand };
      if (sql.startsWith('BEGIN') || sql === 'ROLLBACK') return { rows: [], command: sql.split(' ')[0] };
      if (sql.includes('.studiofy_register_supervisor(')) return { rows: [{ id: JSON.parse(values[0]).supervisor_id }] };
      if (sql.includes('.studiofy_register_executor_birth(')) return { rows: [{ id: JSON.parse(values[0]).executor_id }] };
      if (sql.includes('.studiofy_advance_executor_gate(')) return { rows: [{ state: values[3] }] };
      if (sql.includes('.studiofy_accept_executor_closure(')) {
        const v = JSON.parse(values[0]); receipts.push({ closure_event_id: v.closure_event_id, proof_type: v.proof_type, protocol_version: v.protocol_version,
          executor_id: v.executor_id, boot_id: v.boot_id, supervisor_id: v.supervisor_id, supervisor_boot_id: v.supervisor_boot_id,
          evidence_canonicalization_version: 'pg-jsonb-v1', evidence_hash: 'sha256:' + 'e'.repeat(64) });
        return { rows: [{ id: v.closure_event_id }] };
      }
      if (sql.includes('FROM "' + schema + '".evolution_executor_closure_events')) return { rows: [receipts.at(-1)] };
      if (sql.startsWith('SELECT b.executor_id')) return { rows: [{ executor_id: x.birth.executor_id }] };
      if (sql.startsWith('SELECT e.execution_id')) return { rows: [subject] };
      if (sql.includes('.studiofy_accept_execution_stop(')) return { rows: [{ id: JSON.parse(values[0]).proof_id }] };
      return { rows: [] };
    } };
  const options = { pool: { async connect() { connects++; return client; } }, authority: AUTHORITIES.SUPERVISOR_PROOF_ISSUER,
    issuerLogin: 'test_issuer', migratorLogin: 'test_migrator', executorLogin: 'test_executor', schema, database, localTestOnly: true };
  const runner = createControlSqlRunner(options);
  const authority = createSql031Authority({ transactionRunner: runner,
    issuerIdentity: { supervisor_id: x.supervisor.supervisor_id, supervisor_boot_id: x.supervisor.supervisor_boot_id } });
  return { ...x, options, runner, authority, queries, releases, subject, connects: () => connects };
}
const rejected = fn => assert.throws(fn, { code: 'SQL031_INPUT_INVALID' });

test('SQL031 import has no connection, timer, environment or application side effects', () => {
  const script = `const assert=require('node:assert/strict'),Module=require('node:module');
    const load=Module._load;Module._load=function(n,...a){if(/^(pg|.*database|.*app\\.js|.*booking|.*outbox|.*reminders)$/.test(n))throw Error('forbidden import');return load.call(this,n,...a)};
    global.setInterval=global.setTimeout=()=>{throw Error('timer on import')};
    const before=JSON.stringify(process.env);require('./services/supervision/sql031Authority');
    assert.equal(JSON.stringify(process.env),before);console.log('IMPORT_PASS');`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /IMPORT_PASS/);
});
test('authority has only fixed operations and requires an authentic injected runner', () => {
  const f = peer(); assert.equal(f.connects(), 0);
  assert.deepEqual(Object.keys(f.authority).sort(), ['acceptCooperativeClosure', 'acceptExecutionStop', 'beginExecutorDraining',
    'listExecutionSubjects', 'openExecutorGate', 'registerExecutorBirth', 'registerSupervisor', 'snapshot'].sort());
  rejected(() => createSql031Authority({ transactionRunner: { run() {} }, issuerIdentity: {} }));
  for (const authority of ['MIGRATOR', 'EXECUTOR']) rejected(() => createControlSqlRunner({ ...f.options, authority }));
  rejected(() => createControlSqlRunner({ ...f.options, issuerLogin: f.options.migratorLogin }));
  rejected(() => createControlSqlRunner({ ...f.options, localTestOnly: false }));
  rejected(() => createControlSqlRunner({ ...f.options, schema: 'salaoflix' }));
});
for (const [name, change] of [
  ['unknown field', v => ({ ...v, issuer_role: 'owner' })], ['missing field', v => { delete v.process_id; return v; }],
  ['null', v => ({ ...v, process_id: null })], ['UUID', v => ({ ...v, supervisor_id: 'bad' })],
  ['version', v => ({ ...v, protocol_version: 2 })], ['PID type', v => ({ ...v, process_id: '42' })],
  ['PID range', v => ({ ...v, process_id: 2147483648 })], ['origin', v => ({ ...v, origin: 'child' })],
  ['prototype', v => Object.assign(Object.create(null), v)], ['accessor', v => Object.defineProperty(v, 'revision', { get() { throw Error('getter invoked'); } })],
  ['symbol', v => ({ ...v, [Symbol('secret')]: 1 })],
]) test('supervisor rejects ' + name + ' before connecting', () => {
  const f = peer(); rejected(() => f.authority.registerSupervisor(change({ ...f.supervisor }))); assert.equal(f.connects(), 0);
});
test('supervisor uses fixed SQL and returns only after COMMIT', async () => {
  const f = peer(), r = await f.authority.registerSupervisor(f.supervisor);
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(f.queries.at(-1).sql, 'COMMIT');
  const q = f.queries.find(x => x.sql.includes('.studiofy_register_supervisor('));
  assert.deepEqual(JSON.parse(q.values[0]), f.supervisor); assert.deepEqual(f.releases, [false]);
});
test('birth derives a domain separated fingerprint and strips raw challenge', async () => {
  const f = peer(), r = await f.authority.registerExecutorBirth(f.birth); assert.equal(r.outcome, 'CONFIRMED');
  const payload = JSON.parse(f.queries.find(x => x.sql.includes('.studiofy_register_executor_birth(')).values[0]);
  assert.match(payload.nonce_fingerprint, /^sha256:[a-f0-9]{64}$/); assert.equal(Object.hasOwn(payload, 'session_challenge'), false);
  const material = { supervisor_id: f.birth.supervisor_id, supervisor_boot_id: f.birth.supervisor_boot_id,
    spawn_id: f.birth.spawn_id, executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, session_challenge: f.birth.session_challenge };
  assert.equal(payload.nonce_fingerprint, p.birthNonce(material));
  assert.notEqual(p.birthNonce(material), p.birthNonce({ ...material, spawn_id: randomUUID() }));
  assert.notEqual(p.birthNonce(material), p.birthNonce({ ...material, session_challenge: 'a'.repeat(64) }));
  for (const extra of ['nonce_fingerprint', 'registration_hash', 'issuer_role', 'state']) rejected(() => p.birth({ ...f.birth, [extra]: 'forged' }));
  rejected(() => p.birth({ ...f.birth, runtime_profile: 'other' }));
  rejected(() => p.birth({ ...f.birth, observed_at: '2026-02-30T00:00:00.000Z' }));
});
test('gate wrappers send only OPEN and DRAINING, and reject arbitrary state', async () => {
  const f = peer(), ex = { executor_id: f.birth.executor_id, boot_id: f.birth.boot_id };
  assert.equal((await f.authority.openExecutorGate(ex)).value.state, 'OPEN');
  assert.equal((await f.authority.beginExecutorDraining(ex)).value.state, 'DRAINING');
  await assert.rejects(f.authority.openExecutorGate({ ...ex, state: 'CLOSED' }), { code: 'SQL031_INPUT_INVALID' });
  assert.deepEqual(f.queries.filter(x => x.sql.includes('advance_executor_gate')).map(x => x.values[3]), ['OPEN', 'DRAINING']);
  assert.equal(f.authority.closeGate, undefined);
});
for (const key of ['active_tasks', 'active_descendants', 'active_transports', 'pending_callbacks', 'pending_correlations', 'pending_sql', 'unresolved_sql']) {
  test('closure rejects nonzero or missing ' + key, () => {
    const f = peer(), ev = { ...f.closure.evidence }; delete ev[key];
    rejected(() => p.closure({ ...f.closure, evidence: ev }));
    rejected(() => p.closure({ ...f.closure, evidence: { ...f.closure.evidence, [key]: 1 } }));
  });
}
test('closure validates exact pg-jsonb-v1 evidence, never IPC canonical hash or exit proof', () => {
  const { closure } = inputs(); assert.deepEqual(p.closure(closure), closure);
  for (const delta of [{ proof_type: 'SUPERVISOR_PROCESS_EXIT' }, { evidence_canonicalization_version: 'hmac-v1' },
    { evidence: { ...closure.evidence, evidence_hash: 'forged' } }, { evidence: { ...closure.evidence, admission_closed: false } },
    { evidence: { ...closure.evidence, scope_closed: false } }, { evidence: { ...closure.evidence, runtime_profile: 'bad' } }]) rejected(() => p.closure({ ...closure, ...delta }));
});
test('subjects preserve bigint exactly, reject unsafe values and enforce claim shape', () => {
  const { subject } = peer(); assert.equal(p.subject(subject).assinatura_id, '9007199254740993');
  for (const value of [9007199254740992, '9223372036854775808', '01', 0, -1]) rejected(() => p.subject({ ...subject, assinatura_id: value }));
  rejected(() => p.subject({ ...subject, operation_kind: 'whatsapp_messages' }));
  rejected(() => p.subject({ ...subject, operation_token: randomUUID() }));
});
test('proof requires private committed subject/receipt; JSON, cross-authority and child overrides fail', async () => {
  const f = peer(), receipt = (await f.authority.acceptCooperativeClosure(f.closure)).value;
  const subject = (await f.authority.listExecutionSubjects({ executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 10 })).value[0];
  const args = { subject, closureReceipt: receipt, proof_id: randomUUID(), idempotency_key: randomUUID() };
  rejected(() => f.authority.acceptExecutionStop({ ...args, subject: { ...subject } }));
  rejected(() => f.authority.acceptExecutionStop({ ...args, closureReceipt: { ...receipt } }));
  rejected(() => f.authority.acceptExecutionStop({ ...args, assinatura_id: '1' }));
  rejected(() => peer().authority.acceptExecutionStop(args));
  assert.ok(Object.isFrozen(subject)); assert.equal(Object.hasOwn(subject, 'operation_token'), false);
  const r = await f.authority.acceptExecutionStop(args); assert.equal(r.outcome, 'CONFIRMED');
  const payload = JSON.parse(f.queries.find(x => x.sql.includes('.studiofy_accept_execution_stop(')).values[0]);
  assert.equal(payload.assinatura_id, subject.assinatura_id); assert.equal(payload.evidence_hash, receipt.evidence_hash);
  assert.equal(payload.operation_token_fingerprint, subject.operation_token_fingerprint);
});
test('reader cannot adopt by delivery ID; request is frozen across connection await', async () => {
  const f = peer(); await assert.rejects(f.authority.listExecutionSubjects({ executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 1, delivery_id: '1' }), { code: 'SQL031_INPUT_INVALID' });
  const request = { executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 1 };
  const pending = f.authority.listExecutionSubjects(request); request.executor_id = randomUUID();
  assert.equal((await pending).outcome, 'CONFIRMED');
  assert.equal(f.queries.find(x => x.sql.startsWith('SELECT e.execution_id')).values[0], f.birth.executor_id);
});
test('identical requests preserve parent-supplied IDs and keys without retries', async () => {
  const f = peer(); await f.authority.acceptCooperativeClosure(f.closure); await f.authority.acceptCooperativeClosure(f.closure);
  const calls = f.queries.filter(x => x.sql.includes('.studiofy_accept_executor_closure('));
  assert.equal(calls.length, 2); assert.equal(calls[0].values[0], calls[1].values[0]);
});
for (const [name, delta] of [['wrong login', { session_user: 'test_executor' }], ['SET ROLE', { current_user: 'test_executor' }],
  ['owner', { owns_schema: true }], ['superuser', { rolsuper: true }], ['migrator member', { migrator_member: true }], ['executor member', { executor_member: true }],
  ['raw ledger writer', { ledger_write: true }], ['schema CREATE', { schema_create: true }], ['database owner', { owns_database: true }]]) {
  test('actual connection identity rejects ' + name, async () => {
    const f = peer({ identity: delta }), r = await f.authority.registerSupervisor(f.supervisor);
    assert.equal(r.outcome, 'KNOWN_FAILURE'); assert.equal(f.queries.some(x => x.sql.includes('.studiofy_register_supervisor(')), false);
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
  });
}
test('nonlocal connection and caller-only SQL timeout are rejected before SQL', async () => {
  for (const connection of [{ host: 'remote.example' }, { query_timeout: 5 }, { user: 'test_migrator' }]) {
    const f = peer({ connection }); assert.equal((await f.authority.registerSupervisor(f.supervisor)).outcome, 'KNOWN_FAILURE'); assert.equal(f.queries.length, 0);
  }
});
test('known SQL rejection requires acknowledged ROLLBACK and never exposes driver message', async () => {
  const f = peer({ fail: sql => sql.includes('register_supervisor') && Object.assign(Error('password=do-not-leak'), { code: '23514' }) });
  const r = await f.authority.registerSupervisor(f.supervisor); assert.equal(r.outcome, 'KNOWN_FAILURE');
  assert.equal(f.queries.at(-1).sql, 'ROLLBACK'); assert.doesNotMatch(JSON.stringify(r), /password|do-not-leak/);
  assert.equal(f.runner.snapshot().blocked, false);
});
for (const [name, failure] of [['COMMIT ACK loss', sql => sql === 'COMMIT'], ['SQL timeout', sql => sql.includes('register_supervisor')],
  ['ROLLBACK ACK loss', sql => sql.includes('register_supervisor') || sql === 'ROLLBACK']]) {
  test(name + ' yields terminal UNKNOWN, independent accounting, and zero automatic retry', async () => {
    const scope = require('../services/executionScope').createExecutionScope({ certifiable: true });
    scope.setExecutor({ executorId: randomUUID(), bootId: randomUUID() }); await scope.drain(); const seal = scope.sealClosedScope();
    const f = peer({ fail: sql => failure(sql) && Object.assign(Error('private driver details'), { code: name === 'ROLLBACK ACK loss' && sql !== 'ROLLBACK' ? '23514' : '08006' }) });
    const r = await f.authority.registerSupervisor(f.supervisor); assert.equal(r.outcome, 'UNKNOWN');
    const count = f.queries.length; assert.equal((await f.authority.registerSupervisor(f.supervisor)).outcome, 'UNKNOWN');
    assert.equal(f.queries.length, count); assert.equal(f.connects(), 1); assert.deepEqual(f.releases, [true]);
    assert.equal(f.runner.snapshot().unresolvedSql, 1); assert.equal(scope.sealClosedScope(), seal);
    assert.equal(scope.snapshot().certificationBlocked.length, 0); assert.doesNotMatch(JSON.stringify(r), /private driver/);
    if (name === 'COMMIT ACK loss') assert.equal(f.queries.at(-1).sql, 'COMMIT');
  });
}
test('runner does not return confirmation while COMMIT is outstanding', async () => {
  const f = peer(); let release; const original = f.options.pool.connect;
  f.options.pool.connect = async () => {
    const client = await original(); const query = client.query.bind(client);
    client.query = async (sql, values) => { if (sql === 'COMMIT') await new Promise(resolve => { release = resolve; }); return query(sql, values); };
    return client;
  };
  let settled = false; const pending = f.authority.registerSupervisor(f.supervisor).then(r => { settled = true; return r; });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(f.runner.snapshot().pendingSql, 1); release();
  assert.equal((await pending).outcome, 'CONFIRMED');
});
test('a PostgreSQL COMMIT reporting ROLLBACK cannot produce CONFIRMED', async () => {
  const f = peer({ commitCommand: 'ROLLBACK' });
  assert.equal((await f.authority.registerSupervisor(f.supervisor)).outcome, 'KNOWN_FAILURE');
  assert.equal(f.runner.snapshot().confirmed, 0);
});
test('a caught ambiguous query still poisons control accounting and cannot COMMIT', async () => {
  const f = peer({ fail: sql => sql === 'SELECT synthetic_fault' && Object.assign(Error('network'), { code: '08006' }) });
  const r = await f.runner.run(async tx => { await tx.query('SELECT synthetic_fault').catch(() => {}); return 'not success'; });
  assert.equal(r.outcome, 'UNKNOWN'); assert.equal(f.queries.some(x => x.sql === 'COMMIT'), false);
  assert.equal(f.runner.snapshot().blocked, true);
});
