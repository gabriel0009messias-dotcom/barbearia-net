const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createControlSqlRunner, AUTHORITIES } = require('../services/supervision/sql031Transactions');
const { createDormantSql031Gate } = require('../services/supervision/sql031GateIntegration');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ fail, hold, identity = {}, connection = {}, runnerOptions = {}, requiredCapabilities = ['listener'] } = {}) {
  const supervisor = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), protocol_version: 1,
    process_id: 42, origin: 'local-parent-v1' };
  const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
    supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 43,
    session_challenge: 'c'.repeat(64), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
    observed_at: '2026-10-23T00:00:00.000Z', started_at: '2026-10-23T00:00:00.000Z' };
  const database = 'test_sql031_' + 'b'.repeat(32), schema = 'test_' + 'a'.repeat(32);
  const queries = [], commits = [], receipts = [], releases = [];
  let connects = 0, current, registered = false, born = false, gate = null;
  const client = { connectionParameters: { host: '127.0.0.1', database, user: 'test_issuer', query_timeout: 0, ...connection },
    release: broken => releases.push(broken), async query(sql, values) {
      queries.push({ sql, values });
      await hold?.(sql, values, current);
      const error = fail?.(sql, values, current); if (error) throw error;
      if (sql === 'BEGIN') { current = null; return { command: 'BEGIN', rows: [] }; }
      if (sql === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
      if (sql === 'COMMIT') { commits.push(current); return { command: 'COMMIT', rows: [] }; }
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
      assert.fail('Unexpected SQL: ' + sql);
    } };
  const options = { pool: { async connect() { connects++; return client; } }, authority: AUTHORITIES.SUPERVISOR_PROOF_ISSUER,
    issuerLogin: 'test_issuer', migratorLogin: 'test_migrator', executorLogin: 'test_executor', schema, database, localTestOnly: true, ...runnerOptions };
  const runner = createControlSqlRunner(options);
  const input = { transactionRunner: runner, supervisor, birth, requiredCapabilities };
  const control = createDormantSql031Gate(input);
  return { control, executor: control.executor, runner, input, queries, commits, releases,
    connects: () => connects, sqlGate: () => gate };
}
const ready = async f => {
  f.executor.registerCapability('listener', () => {});
  assert.equal((await f.control.bootstrap()).outcome, 'CONFIRMED');
  assert.equal((await f.control.open()).outcome, 'CONFIRMED');
};
const closureCount = f => f.queries.filter(q => q.sql.includes('.studiofy_accept_executor_closure(')).length;

test('import is dormant: no scope singleton, DB, app, supervisor, timers, listeners or env activation', () => {
  const script = `const assert=require('node:assert/strict'),Module=require('node:module');
    const load=Module._load;Module._load=function(n,...a){if(/^(pg|.*database|.*app|.*supervisor|.*executionScope|.*executionCapabilities)$/.test(n))throw Error('forbidden import '+n);return load.call(this,n,...a)};
    global.setTimeout=global.setInterval=()=>{throw Error('timer')};
    const before=JSON.stringify(process.env),symbols=Object.getOwnPropertySymbols(globalThis),events=process.eventNames().map(k=>[k,process.listenerCount(k)]);
    process.env.SQL031_2B_ENABLED='true';const expected=JSON.stringify(process.env);
    require('./services/supervision/sql031GateIntegration');
    assert.equal(JSON.stringify(process.env),expected);assert.deepEqual(Object.getOwnPropertySymbols(globalThis),symbols);
    assert.deepEqual(process.eventNames().map(k=>[k,process.listenerCount(k)]),events);`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('injected authentic authority required; executor gets no self-authorization, proof or release API', () => {
  const f = fixture(); assert.equal(f.connects(), 0);
  assert.throws(() => createDormantSql031Gate({ ...f.input, transactionRunner: { run() {} } }));
  for (const name of ['bootstrap', 'open', 'close', 'createStopProjection', 'certifyNextPage', 'subjects', 'acceptExecutionStop', 'release', 'retry', 'authority', 'transactionRunner']) assert.equal(f.executor[name], undefined);
  assert.deepEqual(Object.keys(f.control).sort(), ['bootstrap', 'close', 'createStopProjection', 'executor', 'open', 'snapshot']);
});

test('requires a bound bootstrap identity and explicit capability coverage; no child/legacy identity override', async () => {
  const f = fixture();
  for (const change of [{ supervisor_id: randomUUID() }, { supervisor_boot_id: randomUUID() }, { executor_id: 'legacy' }, { issuer_role: 'executor' }]) {
    assert.throws(() => createDormantSql031Gate({ ...f.input, birth: { ...f.input.birth, ...change } }));
  }
  assert.throws(() => createDormantSql031Gate({ ...f.input, requiredCapabilities: [] }));
  assert.equal((await f.control.bootstrap({ executor_id: randomUUID() })).outcome, 'KNOWN_FAILURE');
  assert.equal(f.connects(), 0);
});

test('birth precedes OPEN; admission remains fenced until OPEN COMMIT ACK', async () => {
  const ack = deferred(), atCommit = deferred();
  const f = fixture({ hold: async (sql, values, current) => { if (sql === 'COMMIT' && current === 'OPEN') { atCommit.resolve(); await ack.promise; } } });
  await assert.rejects(f.executor.admit('early', () => assert.fail()));
  assert.equal((await f.control.open()).outcome, 'KNOWN_FAILURE'); assert.equal(f.connects(), 0);
  await f.control.bootstrap(); assert.deepEqual(f.commits, ['supervisor', 'birth']);
  await assert.rejects(f.executor.admit('early', () => assert.fail()));
  const opening = f.control.open(); await atCommit.promise;
  assert.equal(f.control.snapshot().admissionAllowed, false);
  await assert.rejects(f.executor.admit('early', () => assert.fail()));
  ack.resolve(); assert.equal((await opening).outcome, 'CONFIRMED');
  assert.equal(await f.executor.admit('work', () => 7), 7);
});

test('bootstrap copies trusted identity before awaits and does not adopt caller mutations', async () => {
  const f = fixture(), id = f.input.birth.executor_id;
  f.input.birth.executor_id = randomUUID(); f.input.supervisor.supervisor_id = randomUUID();
  await f.control.bootstrap();
  const payload = JSON.parse(f.queries.find(q => q.sql.includes('studiofy_register_executor_birth')).values[0]);
  assert.equal(payload.executor_id, id); assert.equal(payload.session_challenge, undefined);
});

for (const kind of ['supervisor', 'birth', 'OPEN', 'DRAINING', 'closure']) {
  test(kind + ' COMMIT no ACK is terminal UNKNOWN, never retried or repaired', async () => {
    const f = fixture({ fail: (sql, values, current) => sql === 'COMMIT' && current === kind ? Object.assign(Error('ACK lost'), { code: '08006' }) : null });
    f.executor.registerCapability('listener', () => {});
    let result = await f.control.bootstrap();
    if (result.outcome === 'CONFIRMED') result = await f.control.open();
    if (result.outcome === 'CONFIRMED') result = await f.control.close();
    assert.equal(result.outcome, 'UNKNOWN'); assert.equal(f.control.snapshot().state, 'UNKNOWN');
    assert.equal(f.control.snapshot().admissionAllowed, false); assert.equal(f.control.snapshot().gate, 'UNKNOWN');
    const count = f.queries.length, connects = f.connects();
    for (const operation of [() => f.control.bootstrap(), () => f.control.open(), () => f.control.close()]) assert.equal((await operation()).outcome, 'UNKNOWN');
    await assert.rejects(f.executor.admit('late', () => assert.fail()));
    assert.equal(f.queries.length, count); assert.equal(f.connects(), connects);
    assert.equal(f.queries.at(-1).sql, 'COMMIT'); assert.equal(f.releases.at(-1), true);
  });
}

for (const transition of ['OPEN', 'DRAINING']) {
  test(transition + ' persistence rejection fails closed without local fallback or retries', async () => {
    const f = fixture({ fail: (sql, values) => sql.includes('studiofy_advance_executor_gate') && values[3] === transition ? Object.assign(Error('rejected'), { code: '23514' }) : null });
    await f.control.bootstrap(); let result = await f.control.open();
    if (transition === 'DRAINING') result = await f.control.close();
    assert.equal(result.outcome, 'KNOWN_FAILURE'); assert.equal(f.control.snapshot().state, 'FAILED');
    const count = f.queries.length; await f.control.open(); await f.control.close();
    await assert.rejects(f.executor.admit('late', () => assert.fail()));
    assert.equal(f.queries.length, count); assert.equal(closureCount(f), 0);
  });
}

test('OPEN -> DRAINING fences synchronously and preserves Promise.race descendant tracking', async () => {
  const f = fixture(), held = deferred(), stopped = deferred(); let child;
  f.executor.registerCapability('listener', () => stopped.promise);
  await f.control.bootstrap(); await f.control.open();
  const root = f.executor.admit('root', async () => {
    child = f.executor.follow('descendant', () => held.promise);
    return Promise.race([child, Promise.resolve('deadline')]);
  });
  assert.equal(await root, 'deadline'); assert.equal(f.executor.snapshot().activeCount, 2);
  const closing = f.control.close();
  assert.equal(f.control.snapshot().admissionAllowed, false);
  await assert.rejects(f.executor.admit('late', () => assert.fail()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.control.snapshot().gate, 'DRAINING'); assert.equal(closureCount(f), 0);
  held.resolve(); await child; await root.completion;
  assert.equal(closureCount(f), 0); stopped.resolve();
  assert.equal((await closing).outcome, 'CONFIRMED'); assert.equal(f.control.snapshot().gate, 'CLOSED');
  assert.deepEqual(f.commits, ['supervisor', 'birth', 'OPEN', 'DRAINING', 'closure']);
});

test('valid cooperative seal is projected unchanged; CLOSED remains distinct from STOPPED', async () => {
  const f = fixture(); await ready(f);
  const result = await f.control.close(); assert.equal(result.outcome, 'CONFIRMED');
  const s = f.control.snapshot(); assert.equal(s.gate, 'CLOSED'); assert.equal(s.state, 'CLOSED');
  assert.equal(s.proof, false); assert.equal(s.stopped, false);
  const payload = JSON.parse(f.queries.find(q => q.sql.includes('studiofy_accept_executor_closure')).values[0]);
  assert.equal(payload.proof_type, 'COOPERATIVE_SCOPE_CLOSED'); assert.equal(payload.evidence_canonicalization_version, 'pg-jsonb-v1');
  assert.equal(payload.evidence.runtime_profile, f.input.birth.runtime_profile);
  assert.deepEqual(Object.keys(payload.evidence).sort(), ['seal_id', 'admission_closed', 'scope_closed', 'active_tasks', 'active_descendants', 'active_transports', 'pending_callbacks', 'pending_correlations', 'pending_sql', 'unresolved_sql', 'runtime_profile'].sort());
  const count = f.queries.length; await f.control.open(); await f.control.close(); assert.equal(f.queries.length, count);
  assert.equal(closureCount(f), 1);
  const operations = f.queries.filter(q => !q.sql.startsWith('SELECT session_user'));
  assert.equal(operations.some(q => /accept_execution_stop|execution_stop_proofs|reservation|delivery|outbox|SET ROLE|^\s*(UPDATE|DELETE|INSERT)\b/i.test(q.sql)), false);
});

test('closure accepts no arbitrary evidence, CLOSED wrapper, process-exit or child identity payload', async () => {
  const f = fixture(); await ready(f);
  for (const payload of [{ evidence: {} }, { executor_id: randomUUID() }, { state: 'CLOSED' }, { proof_type: 'SUPERVISOR_PROCESS_EXIT' }, { timeoutMs: -1 }]) {
    await assert.rejects(f.control.close(payload));
  }
  assert.equal(closureCount(f), 0); assert.equal(f.control.snapshot().gate, 'OPEN');
});

test('missing capability coverage invalidates closure even with empty task accounting', async () => {
  const f = fixture(); await f.control.bootstrap(); await f.control.open();
  assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE');
  assert.equal(f.control.snapshot().gate, 'DRAINING'); assert.equal(closureCount(f), 0);
});

test('failed capability shutdown cannot certify closure', async () => {
  const f = fixture(); f.executor.registerCapability('listener', () => { throw Error('not closed'); });
  await f.control.bootstrap(); await f.control.open();
  assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE'); assert.equal(closureCount(f), 0);
});

test('timeout cannot certify active tasks; later settlement does not automatically repair or close', async () => {
  const f = fixture(), held = deferred(); await ready(f);
  const task = f.executor.admit('held', () => held.promise);
  assert.equal((await f.control.close({ timeoutMs: 0 })).outcome, 'KNOWN_FAILURE');
  assert.equal(closureCount(f), 0); held.resolve(); await task; await task.completion;
  const count = f.queries.length; await f.control.close(); assert.equal(f.queries.length, count);
});

for (const kind of ['transport', 'callback', 'correlation', 'sql']) {
  test('unresolved ' + kind + ' prevents closure', async () => {
    const f = fixture(); await ready(f); const obligation = f.executor.obligation(kind);
    assert.equal((await f.control.close({ timeoutMs: 0 })).outcome, 'KNOWN_FAILURE');
    obligation.finish(); assert.equal(closureCount(f), 0);
  });
  test('UNKNOWN ' + kind + ' stays irreversible even after finish', async () => {
    const f = fixture(); await ready(f); const obligation = f.executor.obligation(kind);
    obligation.unknown('UNRESOLVED_' + kind); obligation.finish();
    assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE');
    assert.equal(closureCount(f), 0); assert.equal(f.executor.snapshot().obligations.length, 1);
  });
}

test('inconsistent/shared authority accounting blocks admission and closure', async () => {
  const f = fixture(); await ready(f);
  await f.runner.run(() => { throw Object.assign(Error('rejected'), { code: '23514' }); });
  await assert.rejects(f.executor.admit('late', () => assert.fail()));
  assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE'); assert.equal(closureCount(f), 0);
});

test('late certification blocker during drain prevents persistence of closure', async () => {
  const f = fixture(), held = deferred(); await ready(f);
  const task = f.executor.admit('held', () => held.promise), closing = f.control.close();
  f.executor.blockCertification('LATE_UNKNOWN'); held.resolve(); await task;
  assert.equal((await closing).outcome, 'KNOWN_FAILURE'); assert.equal(closureCount(f), 0);
});

test('external unresolved control SQL propagates UNKNOWN without another connection', async () => {
  const f = fixture(); await ready(f);
  assert.equal((await f.runner.run(() => { throw Object.assign(Error('unknown'), { code: '08006' }); })).outcome, 'UNKNOWN');
  const count = f.queries.length;
  assert.equal((await f.control.close()).outcome, 'UNKNOWN');
  assert.equal(f.control.snapshot().state, 'UNKNOWN'); assert.equal(f.control.snapshot().gate, 'UNKNOWN');
  assert.equal(f.queries.length, count); assert.equal(closureCount(f), 0);
});

test('accounting becoming UNKNOWN during structured drain prevents closure and remains UNKNOWN', async () => {
  const f = fixture(), held = deferred(); await ready(f);
  const task = f.executor.admit('held', () => held.promise), closing = f.control.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.runner.run(() => { throw Object.assign(Error('unknown'), { code: '08006' }); })).outcome, 'UNKNOWN');
  held.resolve(); await task;
  assert.equal((await closing).outcome, 'UNKNOWN'); assert.equal(closureCount(f), 0);
});

test('DRAINING ACK precedes resource shutdown and closure; local admission is already fenced', async () => {
  const ack = deferred(), atCommit = deferred(); let stops = 0;
  const f = fixture({ hold: async (sql, values, current) => { if (sql === 'COMMIT' && current === 'DRAINING') { atCommit.resolve(); await ack.promise; } } });
  f.executor.registerCapability('listener', () => { stops++; });
  await f.control.bootstrap(); await f.control.open(); const closing = f.control.close();
  await atCommit.promise;
  assert.equal(stops, 0); assert.equal(closureCount(f), 0); assert.equal(f.control.snapshot().admissionAllowed, false);
  await assert.rejects(f.executor.admit('late', () => assert.fail()));
  ack.resolve(); assert.equal((await closing).outcome, 'CONFIRMED'); assert.equal(stops, 1);
});

test('CLOSED is not reported before closure COMMIT ACK', async () => {
  const ack = deferred(), atCommit = deferred();
  const f = fixture({ hold: async (sql, values, current) => { if (sql === 'COMMIT' && current === 'closure') { atCommit.resolve(); await ack.promise; } } });
  await ready(f); const closing = f.control.close(); await atCommit.promise;
  assert.equal(f.control.snapshot().state, 'SEALING'); assert.equal(f.control.snapshot().gate, 'DRAINING');
  assert.equal(f.control.snapshot().stopped, false);
  ack.resolve(); await closing; assert.equal(f.control.snapshot().gate, 'CLOSED');
});

test('an installed executor supervision context cannot construct parent authority composition', () => {
  const script = `const {createDormantSql031Gate}=require('./services/supervision/sql031GateIntegration');
    const {createControlSqlRunner,AUTHORITIES}=require('./services/supervision/sql031Transactions');
    const {randomUUID:u}=require('node:crypto'),assert=require('node:assert/strict');
    require('./services/supervision/context').install({identity:{},schemaAlreadyPrepared(){},confirmEnrollment(){}});
    const s={supervisor_id:u(),supervisor_boot_id:u(),protocol_version:1,process_id:1,origin:'local-parent-v1'};
    const b={...s,executor_id:u(),boot_id:u(),spawn_id:u(),observed_pid:2,session_challenge:'c'.repeat(64),
      runtime_profile:'evolution-single-process-v1',observed_at:'2026-10-23T00:00:00.000Z',started_at:'2026-10-23T00:00:00.000Z'};
    delete b.process_id;delete b.origin;
    const r=createControlSqlRunner({pool:{connect(){assert.fail()}},authority:AUTHORITIES.SUPERVISOR_PROOF_ISSUER,
      issuerLogin:'issuer',migratorLogin:'migrator',executorLogin:'executor',schema:'test_'+'a'.repeat(32),database:'test_sql031_'+'b'.repeat(32),localTestOnly:true});
    assert.throws(()=>createDormantSql031Gate({transactionRunner:r,supervisor:s,birth:b,requiredCapabilities:['listener']}));`;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('concurrent lifecycle calls never duplicate enrollment, gate transition or closure', async () => {
  const f = fixture(); f.executor.registerCapability('listener', () => {});
  const first = f.control.bootstrap(); assert.equal((await f.control.bootstrap()).outcome, 'KNOWN_FAILURE'); await first;
  const open = f.control.open(); assert.equal((await f.control.open()).outcome, 'KNOWN_FAILURE'); await open;
  const close = f.control.close(); assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE'); await close;
  assert.deepEqual(f.commits, ['supervisor', 'birth', 'OPEN', 'DRAINING', 'closure']);
});

for (const identity of [{ current_user: 'test_executor' }, { session_user: 'test_executor' }, { ledger_write: true }, { migrator_member: true }]) {
  test('real connection identity checks reject ' + JSON.stringify(identity), async () => {
    const f = fixture({ identity }); assert.equal((await f.control.bootstrap()).outcome, 'KNOWN_FAILURE');
    assert.equal(f.queries.some(q => q.sql.includes('studiofy_register_executor_birth')), false);
    assert.equal(f.control.snapshot().admissionAllowed, false);
  });
}

test('executor login cannot be supplied as issuer; local-only guard and permission blocker remain', () => {
  assert.throws(() => fixture({ runnerOptions: { issuerLogin: 'test_executor' } }));
  assert.throws(() => fixture({ runnerOptions: { localTestOnly: false } }));
  assert.throws(() => fixture({ runnerOptions: { authority: AUTHORITIES.EXECUTOR } }));
  const f = fixture(); assert.equal(f.control.snapshot().persistentEmissionEnabled, false);
  assert.equal(f.control.snapshot().activationBlocker, '3B_PERMISSION_SEPARATION_REQUIRED');
});
