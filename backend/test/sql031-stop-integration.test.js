const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createControlSqlRunner, AUTHORITIES } = require('../services/supervision/sql031Transactions');
const { createDormantSql031Gate } = require('../services/supervision/sql031GateIntegration');

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
  let connects = 0, current, registered = false, born = false, gate = null;
  const client = { connectionParameters: { host: '127.0.0.1', database, user: 'test_issuer', query_timeout: 0, ...connection },
    release: broken => releases.push(broken), async query(sql, values) {
      queries.push({ sql, values });
      await hold?.(sql, values, current);
      const error = fail?.(sql, values, current); if (error) throw error;
      if (sql.startsWith('BEGIN')) { current = null; return { command: 'BEGIN', rows: [] }; }
      if (sql === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
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

const { createSql031Authority } = require('../services/supervision/sql031Authority');
const { createDormantSql031StopProjection } = require('../services/supervision/sql031StopIntegration');
const closed = async f => { await ready(f); assert.equal((await f.control.close()).outcome, 'CONFIRMED'); return f.control.createStopProjection(); };
const proofQueries = f => f.queries.filter(q => q.sql.includes('.studiofy_accept_execution_stop('));

test('STOP import is dormant even with activation environment set', () => {
  const r = spawnSync(process.execPath, ['-e', `const assert=require('node:assert/strict'),M=require('node:module'),load=M._load;
    M._load=function(n,...a){if(/pg|database|GateIntegration|executionScope|app.js/.test(n))throw Error(n);return load.call(this,n,...a)};
    global.setTimeout=global.setInterval=()=>{throw Error('timer')};process.env.SQL031_2C_ENABLED='true';
    const env=JSON.stringify(process.env),events=process.eventNames().map(k=>[k,process.listenerCount(k)]);
    require('./services/supervision/sql031StopIntegration');assert.equal(JSON.stringify(process.env),env);
    assert.deepEqual(process.eventNames().map(k=>[k,process.listenerCount(k)]),events);`],
  { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('only confirmed CLOSED supervisor can create capability; executor has no privileged surface', async () => {
  const f = fixture(); assert.throws(() => f.control.createStopProjection());
  await ready(f); assert.throws(() => f.control.createStopProjection());
  for (const key of ['createStopProjection', 'authority', 'subjects', 'certifyNextPage', 'acceptExecutionStop', 'closureReceipt', 'query']) assert.equal(f.executor[key], undefined);
  const cap = await (async () => { await f.control.close(); return f.control.createStopProjection(); })();
  assert.deepEqual(Object.keys(cap), ['certifyNextPage', 'snapshot']);
  assert.equal(f.stops.length, 0); assert.equal(f.control.snapshot().stopped, false);
  assert.equal(cap.snapshot().activationBlocker, '3B_PERMISSION_SEPARATION_REQUIRED');
  assert.equal(cap.snapshot().persistentEmissionEnabled, false);
  assert.throws(() => f.control.createStopProjection({ closureReceipt: f.receipts[0] }));
  await assert.rejects(cap.certifyNextPage({ subjects: f.rows })); assert.equal(proofQueries(f).length, 0);
});

for (const code of ['23514', '08006']) test('closure ' + code + ' never creates operational STOP capability', async () => {
  const f = fixture({ fail: sql => sql.includes('.studiofy_accept_executor_closure(') ? Object.assign(Error('synthetic'), { code }) : undefined });
  await ready(f); const r = await f.control.close(); assert.equal(r.outcome, code === '23514' ? 'KNOWN_FAILURE' : 'UNKNOWN');
  assert.throws(() => f.control.createStopProjection()); assert.equal(proofQueries(f).length, 0);
});

test('original authority and original receipt reach proofs; each execution commits individually', async () => {
  const atSecond = deferred(), resume = deferred();
  const f = fixture({ hold: async (sql, values) => {
    if (sql.includes('.studiofy_accept_execution_stop(') && JSON.parse(values[0]).execution_id.endsWith('000002')) {
      atSecond.resolve(); await resume.promise;
    }
  } });
  const cap = await closed(f), pending = cap.certifyNextPage(); await atSecond.promise;
  assert.deepEqual(f.stops, [f.rows[0].execution_id]); // A proof has not promoted B.
  resume.resolve(); const result = await pending;
  assert.equal(result.outcome, 'CONFIRMED'); assert.equal(result.value.confirmed.length, 2);
  assert.deepEqual(f.stops, f.rows.map(r => r.execution_id));
  assert.equal(new Set(f.proofs.map(p => p.proof_id)).size, 2);
  assert.equal(new Set(f.proofs.map(p => p.idempotency_key)).size, 2);
  for (const proof of f.proofs) {
    assert.equal(proof.evidence_hash, f.receipts[0].evidence_hash);
    assert.equal(proof.evidence_canonicalization_version, 'pg-jsonb-v1');
    assert.equal(Object.hasOwn(proof, 'operation_token'), false);
  }
  const n = f.queries.length;
  assert.strictEqual(await cap.certifyNextPage(), result); assert.equal(f.queries.length, n);
  assert.strictEqual(f.control.createStopProjection(), cap);
});

test('same authentic authority is mandatory; original receipt works and copies/reconstruction fail before proof SQL', async () => {
  const f = fixture(), identity = { supervisor_id: f.input.supervisor.supervisor_id, supervisor_boot_id: f.input.supervisor.supervisor_boot_id };
  const authority = createSql031Authority({ transactionRunner: f.runner, issuerIdentity: identity });
  const ex = { executor_id: f.input.birth.executor_id, boot_id: f.input.birth.boot_id }, binding = { ...ex, ...identity };
  await authority.registerSupervisor(f.input.supervisor); await authority.registerExecutorBirth(f.input.birth);
  await authority.openExecutorGate(ex); await authority.beginExecutorDraining(ex);
  const result = await authority.acceptCooperativeClosure({ ...binding, closure_event_id: randomUUID(),
    proof_type: 'COOPERATIVE_SCOPE_CLOSED', protocol_version: 1, origin: 'supervisor-ipc-v1',
    evidence_canonicalization_version: 'pg-jsonb-v1', observed_at: '2026-10-23T01:00:00.000Z', idempotency_key: randomUUID(),
    evidence: { seal_id: randomUUID(), admission_closed: true, scope_closed: true, active_tasks: 0, active_descendants: 0,
      active_transports: 0, pending_callbacks: 0, pending_correlations: 0, pending_sql: 0, unresolved_sql: 0,
      runtime_profile: f.input.birth.runtime_profile } });
  assert.equal(result.outcome, 'CONFIRMED'); const receipt = result.value;
  const other = createSql031Authority({ transactionRunner: f.runner, issuerIdentity: identity });
  for (const [auth, closureReceipt] of [[authority, Object.freeze({ ...receipt })],
    [authority, Object.freeze(JSON.parse(JSON.stringify(receipt)))], [other, receipt]]) {
    const cap = createDormantSql031StopProjection({ authority: auth, closureReceipt, binding, isClosed: () => true });
    assert.equal((await cap.certifyNextPage()).outcome, 'KNOWN_FAILURE'); assert.equal(proofQueries(f).length, 0);
  }
  const cap = createDormantSql031StopProjection({ authority, closureReceipt: receipt, binding, isClosed: () => true });
  assert.equal((await cap.certifyNextPage()).outcome, 'CONFIRMED'); assert.equal(proofQueries(f).length, 2);
});

test('101 ledger subjects use private ordered cursor and distinct individual transactions', async () => {
  const f = fixture({ count: 101 }), cap = await closed(f);
  const a = cap.certifyNextPage(), concurrent = cap.certifyNextPage(); assert.strictEqual(a, concurrent);
  const first = await a; assert.equal(first.value.complete, false); assert.equal(first.value.confirmed.length, 100);
  assert.equal(cap.snapshot().cursor, f.rows[99].execution_id);
  const frozen = cap.snapshot(); assert.equal(Object.isFrozen(frozen), true);
  await assert.rejects(cap.certifyNextPage({ after_execution_id: f.rows[100].execution_id }));
  const second = await cap.certifyNextPage(); assert.equal(second.value.complete, true); assert.equal(second.value.confirmed.length, 1);
  const reads = f.queries.filter(q => q.sql.startsWith('SELECT e.execution_id'));
  assert.equal(reads.length, 2); assert.equal(reads[0].values[3], null); assert.equal(reads[1].values[3], f.rows[99].execution_id);
  assert.equal(f.stops.length, 101); assert.equal(cap.snapshot().confirmed.length, 101);
});

for (const code of ['23514', '08006']) test('partial page ' + code + ' preserves confirmed prefix and is terminal without replay', async () => {
  const f = fixture({ count: 3, fail: (sql, values) => sql.includes('.studiofy_accept_execution_stop(') &&
    JSON.parse(values[0]).execution_id.endsWith('000002') ? Object.assign(Error('synthetic'), { code }) : undefined });
  const cap = await closed(f), result = await cap.certifyNextPage();
  assert.equal(result.outcome, code === '23514' ? 'KNOWN_FAILURE' : 'UNKNOWN');
  assert.equal(result.value.confirmed.length, 1); assert.equal(result.value.cursor, f.rows[0].execution_id);
  assert.equal(result.value.attempt.execution_id, f.rows[1].execution_id);
  const attempt = cap.snapshot().attempt, n = f.queries.length;
  for (let i = 0; i < 3; i++) assert.strictEqual(await cap.certifyNextPage(), result);
  assert.strictEqual(cap.snapshot().attempt, attempt); assert.strictEqual(f.control.createStopProjection(), cap);
  assert.equal(f.queries.length, n); assert.equal(proofQueries(f).length, 2); assert.deepEqual(f.stops, [f.rows[0].execution_id]);
});

test('legacy/unbound selection fails before any proof and cannot be adopted', async () => {
  const f = fixture({ unbound: true }), cap = await closed(f);
  assert.equal((await cap.certifyNextPage()).outcome, 'KNOWN_FAILURE'); assert.equal(proofQueries(f).length, 0);
});

test('SQL surface contains only control operations; no delivery, reservation, token, disposition or outbox mutation', async () => {
  const f = fixture(), cap = await closed(f); assert.equal((await cap.certifyNextPage()).outcome, 'CONFIRMED');
  for (const { sql } of f.queries) assert.doesNotMatch(sql, /UPDATE |DELETE |INSERT |release|repair|retry|outbox|disposition|SET ROLE/i);
  assert.equal(f.proofs.every(p => p.proof_type === 'COOPERATIVE_SCOPE_CLOSED'), true);
});

for (const corrupt of [rows => { rows[1].boot_id = randomUUID(); }, rows => { rows.reverse(); }]) {
  test('entire ledger page is checked before the first proof; mismatched or unordered subjects stop certification', async () => {
    const f = fixture(); corrupt(f.rows); const cap = await closed(f);
    assert.equal((await cap.certifyNextPage()).outcome, 'KNOWN_FAILURE'); assert.equal(proofQueries(f).length, 0);
  });
}

test('empty CLOSED boot finishes without inventing subjects or issuing proofs', async () => {
  const f = fixture({ count: 0 }), cap = await closed(f), r = await cap.certifyNextPage();
  assert.equal(r.outcome, 'CONFIRMED'); assert.equal(r.value.complete, true); assert.equal(r.value.cursor, null);
  assert.equal(r.value.confirmed.length, 0); assert.equal(proofQueries(f).length, 0);
  const n = f.queries.length; assert.strictEqual(await cap.certifyNextPage(), r); assert.equal(f.queries.length, n);
});
