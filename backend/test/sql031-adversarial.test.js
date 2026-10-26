const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, ready, closed, deferred, proofQueries } = require('./helpers/sql031AdversarialFixtures');
const { createSql031Authority } = require('../services/supervision/sql031Authority');
const { createDormantSql031StopProjection } = require('../services/supervision/sql031StopIntegration');
const p = require('../services/supervision/sql031Payloads');

test('A01/A04/D01: executor has no issuer surface; caller cannot choose subjects or issue early STOP', async () => {
  const f = fixture();
  for (const key of ['authority', 'bootstrap', 'open', 'close', 'createStopProjection', 'acceptExecutionStop', 'query']) {
    assert.equal(f.executor[key], undefined);
  }
  assert.throws(() => f.control.createStopProjection());
  await ready(f); assert.throws(() => f.control.createStopProjection());
  await f.control.close(); const cap = f.control.createStopProjection();
  for (const input of [{ subjects: f.rows }, { subject: f.rows[0] }, { execution_id: randomUUID() }, { operation_token: randomUUID() }]) {
    await assert.rejects(cap.certifyNextPage(input), { code: 'SQL031_INPUT_INVALID' });
  }
  assert.equal(proofQueries(f).length, 0);
});

for (const phase of ['OPEN', 'DRAINING', 'CLOSED']) {
  test('B02/B03: root and unparented descendants at ' + phase, async () => {
    const f = fixture(); await ready(f);
    let calls = 0;
    const work = () => { calls++; };
    const held = phase === 'DRAINING' ? f.executor.obligation('held.sql') : null;
    const closing = phase === 'OPEN' ? null : f.control.close();
    if (phase === 'CLOSED') await closing;
    assert.equal(f.control.snapshot().state, phase);
    if (phase !== 'OPEN') await assert.rejects(f.executor.admit('root', work), { code: 'INSTANCE_ADMISSION_CLOSED' });
    await assert.rejects(f.executor.follow('orphan', work), { code: 'INSTANCE_ADMISSION_CLOSED' });
    let scheduled = 0, queued;
    const schedule = global.setImmediate;
    global.setImmediate = () => { scheduled++; throw Error('Orphan callback was scheduled'); };
    try { queued = f.executor.enqueue('orphan.queue', work); }
    finally { global.setImmediate = schedule; }
    await assert.rejects(queued.result, { code: 'INSTANCE_ADMISSION_CLOSED' });
    // One event-loop turn would run any incorrectly scheduled setImmediate callback.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0); assert.equal(scheduled, 0); assert.equal(f.executor.snapshot().activeCount, 0);
    held?.finish(); if (closing) assert.equal((await closing).outcome, 'CONFIRMED');
  });
}

test('B03: expired parent cannot follow/enqueue; scheduler is not invoked for an orphan', async () => {
  const f = fixture(); await ready(f);
  let calls = 0;
  // AsyncResource captures the actual parent context, unlike a plain saved function.
  const { AsyncResource } = require('node:async_hooks');
  let continuation;
  await f.executor.admit('capture', () => { continuation = AsyncResource.bind(() => {
    const q = f.executor.enqueue('expired.queue', () => { calls++; });
    return Promise.all([assert.rejects(f.executor.follow('expired.follow', () => { calls++; })), assert.rejects(q.result)]);
  }); });
  await continuation(); assert.equal(calls, 0); assert.equal(f.executor.snapshot().activeCount, 0);
  const { createExecutionScope } = require('../services/executionScope');
  const scope = createExecutionScope({ certifiable: true }); let schedules = 0;
  const queued = scope.enqueue('orphan', () => { calls++; }, { schedule() { schedules++; }, cancel() {} });
  await assert.rejects(queued.result); assert.equal(schedules, 0); assert.equal(scope.snapshot().activeCount, 0);
});

for (const stage of ['supervisor', 'birth', 'closure']) {
  test('B04/C04: KNOWN_FAILURE ' + stage + ' is terminal, with acknowledged rollback', async () => {
    const needle = { supervisor: 'studiofy_register_supervisor(', birth: 'studiofy_register_executor_birth(', closure: 'studiofy_accept_executor_closure(' }[stage];
    const f = fixture({ fail: sql => sql.includes(needle) ? Object.assign(Error('synthetic SQL rejection'), { code: '23514' }) : undefined });
    f.executor.registerCapability('listener', () => {});
    let result = await f.control.bootstrap();
    if (stage === 'closure') { await f.control.open(); result = await f.control.close(); }
    assert.equal(result.outcome, 'KNOWN_FAILURE'); assert.equal(f.control.snapshot().state, 'FAILED');
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(f.sqlGate(), stage === 'closure' ? 'DRAINING' : null);
    assert.deepEqual(f.commits, stage === 'supervisor' ? [] : stage === 'birth' ? ['supervisor'] : ['supervisor', 'birth', 'OPEN', 'DRAINING']);
    const before = f.queries.length;
    for (let i = 0; i < 3; i++) {
      for (const op of ['bootstrap', 'open', 'close']) assert.equal((await f.control[op]()).outcome, 'KNOWN_FAILURE');
      assert.throws(() => f.control.createStopProjection());
      await assert.rejects(f.executor.admit('late', () => assert.fail('admitted after failure')));
    }
    assert.equal(f.queries.length, before); assert.equal(proofQueries(f).length, 0);
  });
}

test('C01: pre-open closure and incoherent control accounting cannot close', async () => {
  const f = fixture(); assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE');
  assert.equal(f.queries.length, 0); await ready(f);
  await f.runner.run(async () => { throw Object.assign(Error('known failure'), { code: '23514' }); });
  assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE');
  assert.equal(f.queries.some(q => q.sql.includes('studiofy_accept_executor_closure(')), false);
  assert.throws(() => f.control.createStopProjection());
});

for (const stage of ['OPEN', 'DRAINING']) {
  test('B04: KNOWN_FAILURE ' + stage + ' preserves the previous SQL gate and fences all later work', async () => {
    let rejected = 0;
    const f = fixture({ fail: (sql, values) => {
      if (sql.includes('studiofy_advance_executor_gate(') && values[3] === stage) {
        rejected++; return Object.assign(Error('synthetic transition rejection'), { code: '23514' });
      }
    } });
    f.executor.registerCapability('listener', () => {});
    assert.equal((await f.control.bootstrap()).outcome, 'CONFIRMED');
    if (stage === 'DRAINING') assert.equal((await f.control.open()).outcome, 'CONFIRMED');
    const previous = stage === 'OPEN' ? 'BOOTSTRAPPING' : 'OPEN';
    assert.equal(f.sqlGate(), previous);
    const committed = [...f.commits];
    const result = await (stage === 'OPEN' ? f.control.open() : f.control.close());
    assert.equal(result.outcome, 'KNOWN_FAILURE'); assert.equal(rejected, 1);
    assert.equal(f.control.snapshot().state, 'FAILED');
    assert.equal(f.control.snapshot().gate, previous); assert.equal(f.sqlGate(), previous);
    assert.equal(f.control.snapshot().admissionAllowed, false);
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK'); assert.deepEqual(f.commits, committed);
    const queries = f.queries.length, connects = f.connects();
    for (let i = 0; i < 3; i++) {
      for (const op of ['bootstrap', 'open', 'close']) assert.equal((await f.control[op]()).outcome, 'KNOWN_FAILURE');
      await assert.rejects(f.executor.admit('after.transition.failure', () => assert.fail('late admission')),
        { code: 'INSTANCE_ADMISSION_CLOSED' });
      assert.throws(() => f.control.createStopProjection(), { code: 'SQL031_INPUT_INVALID' });
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.queries.length, queries); assert.equal(f.connects(), connects); assert.equal(rejected, 1);
    assert.equal(f.queries.some(q => q.sql.includes('studiofy_accept_executor_closure(')), false);
    assert.equal(proofQueries(f).length, 0); assert.equal(f.receipts.length, 0); assert.equal(f.stops.length, 0);
    assert.deepEqual(f.commits, committed); assert.equal(f.sqlGate(), previous);
  });
}

for (const kind of ['transport', 'callback', 'correlation', 'sql', 'capability']) {
  test('C02: unresolved ' + kind + ' cannot become closure by timeout', async () => {
    const f = fixture(), held = deferred();
    if (kind === 'capability') {
      f.executor.registerCapability('listener', () => held.promise);
      await f.control.bootstrap(); await f.control.open();
    } else await ready(f);
    const obligation = kind === 'capability' ? null : f.executor.obligation(kind);
    const result = await f.control.close({ timeoutMs: 0 });
    assert.equal(result.outcome, 'KNOWN_FAILURE'); assert.equal(f.sqlGate(), 'DRAINING');
    const n = f.queries.length; obligation?.finish(); held.resolve();
    assert.equal((await f.control.close()).outcome, 'KNOWN_FAILURE');
    assert.throws(() => f.control.createStopProjection()); assert.equal(f.queries.length, n);
    assert.equal(proofQueries(f).length, 0);
  });
}

test('C03: copied, tampered and foreign receipts cannot authorize proofs', async () => {
  const f = fixture(); const identity = { supervisor_id: f.input.supervisor.supervisor_id, supervisor_boot_id: f.input.supervisor.supervisor_boot_id };
  const a = createSql031Authority({ transactionRunner: f.runner, issuerIdentity: identity });
  const ex = { executor_id: f.input.birth.executor_id, boot_id: f.input.birth.boot_id };
  await a.registerSupervisor(f.input.supervisor); await a.registerExecutorBirth(f.input.birth);
  await a.openExecutorGate(ex); await a.beginExecutorDraining(ex);
  // Explicit synthetic driver fixture; not evidence received from a child process.
  const receipt = (await a.acceptCooperativeClosure({ ...ex, ...identity, closure_event_id: randomUUID(),
    proof_type: 'COOPERATIVE_SCOPE_CLOSED', protocol_version: 1, origin: 'supervisor-ipc-v1',
    observed_at: '2026-10-23T00:00:00.000Z', idempotency_key: randomUUID(), evidence_canonicalization_version: 'pg-jsonb-v1',
    evidence: { seal_id: randomUUID(), admission_closed: true, scope_closed: true, active_tasks: 0, active_descendants: 0,
      active_transports: 0, pending_callbacks: 0, pending_correlations: 0, pending_sql: 0, unresolved_sql: 0,
      runtime_profile: f.input.birth.runtime_profile } })).value;
  const other = createSql031Authority({ transactionRunner: f.runner, issuerIdentity: identity });
  const selected = await a.listExecutionSubjects({ ...ex, limit: 100 });
  assert.equal(selected.outcome, 'CONFIRMED');
  assert.throws(() => a.acceptExecutionStop({ subject: Object.freeze({ ...selected.value[0] }), closureReceipt: receipt,
    proof_id: randomUUID(), idempotency_key: randomUUID() }), { code: 'SQL031_INPUT_INVALID' });
  const foreign = fixture(); await ready(foreign);
  const foreignClosure = await foreign.control.close();
  assert.equal(foreignClosure.outcome, 'CONFIRMED');
  assert.throws(() => a.acceptExecutionStop({ subject: selected.value[0], closureReceipt: foreignClosure.value,
    proof_id: randomUUID(), idempotency_key: randomUUID() }), { code: 'SQL031_INPUT_INVALID' });
  for (const [authority, closureReceipt] of [[a, Object.freeze({ ...receipt })],
    [a, Object.freeze({ ...receipt, evidence_hash: 'sha256:' + '0'.repeat(64) })], [other, receipt]]) {
    const cap = createDormantSql031StopProjection({ authority, closureReceipt, binding: { ...ex, ...identity }, isClosed: () => true });
    assert.equal((await cap.certifyNextPage()).outcome, 'KNOWN_FAILURE');
  }
  assert.equal(proofQueries(f).length, 0);
});

for (const stage of ['supervisor', 'birth', 'OPEN', 'DRAINING', 'closure']) {
  test('E01/E02: synthetic control ACK loss at ' + stage + ' never resumes', async () => {
    const f = fixture({ fail: (sql, values, current) => sql === 'COMMIT' && current === stage ? Object.assign(Error('lost ACK'), { code: '08006' }) : undefined });
    f.executor.registerCapability('listener', () => {});
    let result = await f.control.bootstrap();
    if (result.outcome === 'CONFIRMED') result = await f.control.open();
    if (result.outcome === 'CONFIRMED') result = await f.control.close();
    assert.equal(result.outcome, 'UNKNOWN'); const n = f.queries.length;
    for (const op of ['bootstrap', 'open', 'close']) assert.equal((await f.control[op]()).outcome, 'UNKNOWN');
    assert.throws(() => f.control.createStopProjection()); assert.equal(f.queries.length, n);
  });
}

for (const count of [0, 1, 99, 100, 101, 200, 201]) {
  test('F02: ordered explicit pagination boundary ' + count, async () => {
    const f = fixture({ count }), cap = await closed(f); let total = 0, pages = 0, done = false;
    while (!done) {
      const readsBefore = f.queries.filter(q => q.sql.startsWith('SELECT e.execution_id')).length;
      const a = cap.certifyNextPage(), b = cap.certifyNextPage(); assert.strictEqual(a, b);
      const result = await a; assert.equal(result.outcome, 'CONFIRMED'); pages++;
      assert.ok(result.value.confirmed.length <= 100); total += result.value.confirmed.length;
      assert.equal(cap.snapshot().cursor, total ? f.rows[total - 1].execution_id : null);
      assert.equal(f.queries.filter(q => q.sql.startsWith('SELECT e.execution_id')).length, readsBefore + 1);
      const n = f.queries.length; await new Promise(resolve => setImmediate(resolve)); assert.equal(f.queries.length, n);
      done = result.value.complete;
    }
    assert.equal(pages, Math.floor(count / 100) + 1); assert.equal(total, count);
    assert.deepEqual(f.stops, f.rows.map(r => r.execution_id));
    assert.equal(new Set(f.proofs.map(r => r.proof_id)).size, count);
    assert.equal(new Set(f.proofs.map(r => r.idempotency_key)).size, count);
  });
}

for (const attack of ['reverse', 'duplicate', 'executor', 'boot']) {
  test('F03: entire malformed page rejected before proof: ' + attack, async () => {
    const f = fixture();
    if (attack === 'reverse') f.rows.reverse();
    else if (attack === 'duplicate') f.rows[1] = { ...f.rows[0] };
    else f.rows[1][attack === 'executor' ? 'executor_id' : 'boot_id'] = randomUUID();
    const cap = await closed(f); assert.equal((await cap.certifyNextPage()).outcome, 'KNOWN_FAILURE');
    assert.equal(proofQueries(f).length, 0); assert.equal(f.stops.length, 0);
  });
}

test('D03/K02: malformed cooperative closure and process-exit modality are rejected', async () => {
  const f = fixture(); await ready(f);
  for (const input of [null, { evidence: {} }, { proof_type: 'SUPERVISOR_PROCESS_EXIT' }, { state: 'CLOSED' }, { timeoutMs: '0' }]) {
    await assert.rejects(f.control.close(input));
  }
  for (const row of [null, {}, { ...f.rows[0], extra: true }, { ...f.rows[0], execution_id: null }, { ...f.rows[0], execution_id: 1 }]) {
    assert.throws(() => p.subject(row), { code: 'SQL031_INPUT_INVALID' });
  }
  assert.equal(proofQueries(f).length, 0);
});

test('K02: otherwise valid cooperative payload rejects only the substituted process-exit modality', async () => {
  const f = fixture(); await ready(f);
  assert.equal((await f.control.close()).outcome, 'CONFIRMED');
  const cooperative = JSON.parse(f.queries.find(q => q.sql.includes('studiofy_accept_executor_closure(')).values[0]);
  assert.equal(p.closure(cooperative).proof_type, 'COOPERATIVE_SCOPE_CLOSED');
  const processExit = { ...cooperative, proof_type: 'SUPERVISOR_PROCESS_EXIT' };
  assert.deepEqual({ ...processExit, proof_type: cooperative.proof_type }, cooperative);
  assert.throws(() => p.closure(processExit), { code: 'SQL031_INPUT_INVALID' });
  const authority = createSql031Authority({ transactionRunner: f.runner, issuerIdentity: {
    supervisor_id: f.input.supervisor.supervisor_id, supervisor_boot_id: f.input.supervisor.supervisor_boot_id } });
  const before = f.queries.length;
  await assert.rejects(authority.acceptCooperativeClosure(processExit), { code: 'SQL031_INPUT_INVALID' });
  // close() accepts options only: its rejection is architectural, not a specific modality diagnostic.
  await assert.rejects(f.control.close(processExit), { code: 'SQL031_INPUT_INVALID' });
  assert.equal(f.queries.length, before); assert.equal(proofQueries(f).length, 0);
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].proof_type, 'COOPERATIVE_SCOPE_CLOSED');
});

test('L01: helper/composition import has no effects at the known instrumented seams', () => {
  const source = `const assert=require('node:assert/strict'),M=require('node:module'),cp=require('node:child_process');
    let effects=0; const deny=()=>{effects++;throw Error('import side effect')};
    for(const k of ['setTimeout','setInterval','setImmediate'])global[k]=deny;
    for(const k of ['spawn','fork','exec','execFile','spawnSync','execSync','execFileSync'])cp[k]=deny;
    require('node:http').Server.prototype.listen=deny;require('node:net').Server.prototype.listen=deny;
    require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;
    for(const name of ['node:http','node:https'])for(const k of ['request','get'])require(name)[k]=deny;
    global.fetch=deny;require('node:dgram').Socket.prototype.bind=deny;require('node:dgram').Socket.prototype.send=deny;
    const fs=require('node:fs');for(const k of ['writeFile','writeFileSync','appendFile','appendFileSync','createWriteStream'])fs[k]=deny;
    for(const k of ['writeFile','appendFile'])fs.promises[k]=deny;
    require('node:worker_threads').Worker=deny;
    const load=M._load;M._load=function(n,...args){if(n==='pg'||/database|app\\.js|evolutionApi|whatsapp/i.test(n))return deny();return load.call(this,n,...args)};
    const listeners=process.eventNames().map(k=>[k,process.listenerCount(k)]);
    const helper=require('./test/helpers/sql031AdversarialFixtures');require('./services/supervision/sql031StopIntegration');
    for(const name of ['fixture','postgresFixture','processFixture','signalParent'])assert.equal(typeof helper[name],'function');
    const fixtureFile=require.resolve('./test/helpers/sql031AdversarialFixtures');
    assert.deepEqual(require.cache[fixtureFile].children.map(m=>m.id.split(String.fromCharCode(92)).join('/'))
      .filter(id=>/supervisor[.]js|database/.test(id)||id.includes('/node_modules/pg/')),[]);
    assert.equal(effects,0);assert.deepEqual(process.eventNames().map(k=>[k,process.listenerCount(k)]),listeners);`;
  const result = spawnSync(process.execPath, ['-e', source], { cwd: path.join(__dirname, '..'),
    env: { NODE_ENV: 'test', SQL031_ENABLED: 'true', SQL031_STOP_ENABLED: 'true', SUPERVISION_ENABLED: 'true' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test('L02: production entrypoints cannot import adversarial tests/helper or enable SQL031 composition', () => {
  const root = path.join(__dirname, '..');
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['test', 'node_modules', '.git', 'docs'].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(js|cjs|json)$/.test(entry.name)) {
        const source = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(source, /sql031AdversarialFixtures|sql031-adversarial/, file);
        if (!file.includes(path.join('services', 'supervision'))) assert.doesNotMatch(source, /require\([^)]*sql031(?:Gate|Stop)Integration/, file);
      }
    }
  };
  visit(root); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts.start, 'node app.js');
  assert.equal(fs.readdirSync(path.join(root, 'database/migrations')).some(f => /^032/.test(f)), false);
});
