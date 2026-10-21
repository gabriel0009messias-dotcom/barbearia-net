const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createExecutionScope } = require('../services/executionScope');
const { createCapabilityCoordinator } = require('../services/executionCapabilities');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scopeFor = () => {
  const scope = createExecutionScope({ certifiable: true });
  scope.setExecutor({ executorId: randomUUID(), bootId: randomUUID() });
  return scope;
};

test('cooperative local seal, capabilities and adversarial scheduling', async t => {
  await t.test('OPEN, DRAINING and legacy CLOSED reject; certified CLOSED is immutable and idempotent', async () => {
    const scope = scopeFor();
    assert.throws(scope.sealClosedScope, { code: 'CERTIFICATION_BLOCKED' });
    scope.beginDrain(); assert.throws(scope.sealClosedScope);
    await scope.drain();
    const seal = scope.sealClosedScope();
    assert.equal(scope.sealClosedScope(), seal); assert.equal(scope.ownsSeal(seal), true);
    assert.equal(scope.ownsSeal(JSON.parse(JSON.stringify(seal))), false);
    assert.ok(Object.isFrozen(seal)); assert.ok(Object.isFrozen(seal.counters));
    assert.equal(seal.closure_generation, 1); assert.equal(seal.protocol_version, 1);
    assert.equal(seal.runtime_profile, 'evolution-single-process-v1');
    assert.throws(() => scope.setExecutor({ executorId: randomUUID(), bootId: randomUUID() }));
    const legacy = createExecutionScope(); await legacy.drain(); assert.throws(legacy.sealClosedScope);
  });
  for (const kind of ['task.active','descendant.active','transport.fetch','transport.body','transport.cancel','callback.active',
    'delivery.provider-correlation','sql.query','sql.transaction','ownership.heartbeat','ownership.boundary']) {
    await t.test(kind + ' blocks seal until real completion', async () => {
      const scope = scopeFor(), release = deferred();
      const parent = scope.admit('root', () => { scope.follow(kind, () => release.promise); });
      await parent;
      assert.equal((await scope.drain({ timeoutMs: 1 })).drained, false);
      assert.throws(scope.sealClosedScope); release.resolve();
      await parent.completion; await scope.drain(); assert.ok(scope.sealClosedScope());
    });
  }
  await t.test('capability manifest and incomplete CLOSED cannot manufacture certification', async () => {
    const scope = scopeFor(); scope.certifyProfile({ requiredCapabilities: ['listener.http'] });
    await scope.drain(); assert.throws(scope.sealClosedScope);
  });
  await t.test('scheduler stop and a fired callback are distinct obligations', async () => {
    const scope = scopeFor(), coordinator = createCapabilityCoordinator(scope), late = deferred();
    let queued, scheduling = true;
    const parent = scope.admit('root', () => scope.enqueue('callback.queued', async () => { await late.promise; await scope.follow('callback.finalize', async () => {}); },
      { schedule: fn => { queued = fn; return 1; }, cancel() {} }));
    await parent; queued();
    coordinator.register('scheduler.synthetic', () => { scheduling = false; });
    const closing = coordinator.drain({ timeoutMs: 1 });
    assert.equal(scheduling, false); assert.equal((await closing).drained, false);
    assert.throws(scope.sealClosedScope); late.resolve(); await parent.completion;
    await coordinator.drain(); assert.ok(coordinator.sealClosedScope());
  });
  await t.test('cancelled queued callback cannot execute later', async () => {
    const scope = scopeFor(); let queued, calls = 0;
    await scope.admit('root', async () => {
      const item = scope.enqueue('callback.queued', () => { calls++; }, { schedule: fn => { queued = fn; }, cancel() {} });
      item.cancel(); await item.completion;
    });
    await scope.drain(); scope.sealClosedScope(); queued(); assert.equal(calls, 0);
  });
  await t.test('known detached work and UNKNOWN SQL permanently reject certification', async () => {
    const scope = scopeFor(); scope.blockCertification('KNOWN_DETACHED_RELEVANT_WORK');
    await scope.drain(); assert.throws(scope.sealClosedScope);
    const sql = scopeFor(), obligation = sql.obligation('sql.commit');
    obligation.unknown(); obligation.finish();
    assert.equal((await sql.drain({ timeoutMs: 1 })).drained, false);
    assert.ok(sql.snapshot().obligations.includes('unknown.sql.commit')); assert.throws(sql.sealClosedScope);
  });
  await t.test('unparented follow rejected and stale callbacks cannot renew, cross boundaries or create work', async () => {
    const scope = scopeFor(); let stale;
    await assert.rejects(scope.follow('unparented', () => assert.fail()));
    await scope.admit('root', () => { stale = scope.bindCallback(async () => {
      assert.throws(scope.assertOpen);
      assert.throws(() => scope.obligation('sql.query'));
      assert.throws(() => scope.registerCapability('transport'));
      await assert.rejects(scope.follow('descendant', () => assert.fail()));
      await assert.rejects(scope.admit('transport', () => assert.fail()));
      await assert.rejects(scope.admitRoot('heartbeat', () => assert.fail()));
    }); });
    await scope.drain(); scope.sealClosedScope(); await stale();
  });
  await t.test('restart, concurrent workers and overlapping boots cannot share a seal', async () => {
    const scopes = [scopeFor(), scopeFor(), scopeFor()];
    await Promise.all(scopes.map(s => s.drain())); const seals = scopes.map(s => s.sealClosedScope());
    assert.equal(new Set(seals.map(s => s.boot_id)).size, 3);
    assert.equal(new Set(seals.map(s => s.seal_id)).size, 3);
    assert.equal(scopes[1].ownsSeal(seals[0]), false);
  });
  await t.test('no issuer/gate fallback, proof or delivery side effects', async () => {
    const scope = scopeFor(), coordinator = createCapabilityCoordinator(scope);
    const fixtures = [{ id: 37, state: 'uncertain', attempts: 1, sent_at: null, operation_token: randomUUID() },
      { id: 69, state: 'pending', attempts: 0, sent_at: null, operation_token: null }];
    const before = structuredClone(fixtures);
    await coordinator.drain(); coordinator.sealClosedScope();
    assert.deepEqual(fixtures, before); assert.equal(coordinator.persistentEmissionEnabled, false);
    assert.equal(coordinator.activationBlocker, '3B_PERMISSION_SEPARATION_REQUIRED');
  });
  await t.test('shutdown timeout cannot seal an unresolved resource; stop failure blocks certification', async () => {
    const scope = scopeFor(), coordinator = createCapabilityCoordinator(scope), wait = deferred();
    coordinator.register('listener.http', () => wait.promise);
    assert.equal((await coordinator.drain({ timeoutMs: 1 })).drained, false); assert.throws(scope.sealClosedScope);
    wait.resolve(); await coordinator.drain(); assert.ok(scope.sealClosedScope());
    const broken = scopeFor(), bad = createCapabilityCoordinator(broken);
    bad.register('listener.http', () => { throw Error('close failed'); });
    await assert.rejects(bad.drain()); assert.throws(broken.sealClosedScope);
  });
  await t.test('closed HTTP response does not finish its relevant async handler', async () => {
    const http = require('node:http'), scope = scopeFor(), coordinator = createCapabilityCoordinator(scope);
    const entered = deferred(), late = deferred();
    const server = http.createServer((request, response) => {
      scope.admit('http.handler', async () => { response.end('synthetic'); entered.resolve(); await late.promise; });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    coordinator.register('listener.http', () => new Promise(resolve => server.close(resolve)));
    const response = new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
      res.resume(); res.on('end', resolve);
    }).on('error', reject));
    await entered.promise; await response;
    assert.equal((await coordinator.drain({ timeoutMs: 2 })).drained, false); assert.throws(scope.sealClosedScope);
    late.resolve(); await coordinator.drain(); assert.ok(scope.sealClosedScope());
  });
  await t.test('generic rejected fetch cannot silently certify transport termination', async () => {
    const api = require('../evolutionApi'), globalScope = require('../services/executionScope').executionScope;
    const originalFetch = globalThis.fetch, originalUrl = process.env.EVOLUTION_API_URL, originalKey = process.env.EVOLUTION_API_KEY;
    process.env.EVOLUTION_API_URL = 'http://127.0.0.1:9'; process.env.EVOLUTION_API_KEY = 'synthetic';
    globalThis.fetch = async () => { throw Error('Synthetic transport outcome unknown'); };
    try {
      await assert.rejects(api.evolutionRequest('/instance/fetchInstances', { retryAttempts: 1 }));
      assert.ok(globalScope.snapshot().certificationBlocked.includes('TRANSPORT_TERMINATION_UNCONFIRMED'));
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.EVOLUTION_API_URL; else process.env.EVOLUTION_API_URL = originalUrl;
      if (originalKey === undefined) delete process.env.EVOLUTION_API_KEY; else process.env.EVOLUTION_API_KEY = originalKey;
    }
  });
  await t.test('temporary admin handler rejects late admission with a response, without an unhandled rejection', async () => {
    const { registerTemporaryEvolutionWebhookAdmin } = require('../temporaryEvolutionWebhookAdmin');
    const globalScope = require('../services/executionScope').executionScope;
    let handler, status, body;
    registerTemporaryEvolutionWebhookAdmin({ post(...args) { handler = args.at(-1); } }, () => {});
    globalScope.beginDrain();
    await handler({}, { status(value) { status = value; return this; }, json(value) { body = value; } });
    assert.equal(status, 503); assert.equal(body.verificacaoConcluida, false);
  });
});
