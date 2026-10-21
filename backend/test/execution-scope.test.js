const { test } = require('node:test');
const { AsyncResource } = require('node:async_hooks');
const assert = require('node:assert/strict');
const { createExecutionScope } = require('../services/executionScope');
const { createOutboxWorker } = require('../services/whatsapp/outboxWorker');
const { startWorker } = require('../services/reminders');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('irreversible admission barrier, timeout and real child completion', async () => {
  const scope = createExecutionScope(), late = deferred(), entered = deferred();
  let child;
  const parent = scope.admit('operation', async () => {
    child = scope.follow('callback', async () => { entered.resolve(); await late.promise; });
    await entered.promise;
    return 'deadline'; // A Promise.race may have returned this already.
  });
  assert.equal(await parent, 'deadline');
  assert.equal(scope.snapshot().activeCount, 2);
  const before = scope.snapshot();
  assert.equal(before.tasks.find(t => t.kind === 'callback').parentTaskId, before.tasks.find(t => t.kind === 'operation').taskId);
  assert.equal(before.tasks.find(t => t.kind === 'operation').state, 'WAITING_FOR_CHILDREN');
  assert.deepEqual(await scope.drain({ timeoutMs: 2 }), { drained: false, state: 'DRAINING' });
  await assert.rejects(scope.admit('new', () => assert.fail()), { code: 'INSTANCE_ADMISSION_CLOSED' });
  await assert.rejects(scope.follow('unparented', () => assert.fail()), { code: 'INSTANCE_ADMISSION_CLOSED' });
  assert.throws(scope.assertOpen, { code: 'INSTANCE_ADMISSION_CLOSED' });
  late.resolve(); await child; await parent.completion;
  assert.deepEqual(await scope.drain(), { drained: true, state: 'CLOSED' });
  assert.equal(scope.snapshot().activeCount, 0);
  assert.ok(scope.snapshot().history.every(t => t.endedAt && ['FULFILLED', 'REJECTED'].includes(t.state)));
  assert.equal(scope.beginDrain(), 'CLOSED');
});

test('late continuation remains counted; stale task context cannot resurrect work', async () => {
  const scope = createExecutionScope(), late = deferred(), sql = deferred(); let stale;
  const work = scope.admit('callback', async () => {
    stale = () => scope.follow('resurrection', () => assert.fail());
    await late.promise;
    await scope.follow('correlation.sql', () => sql.promise);
  });
  scope.beginDrain(); late.resolve(); await turn();
  assert.equal(scope.snapshot().activeCount, 2);
  assert.equal((await scope.drain({ timeoutMs: 1 })).drained, false);
  sql.resolve(); await work; await scope.drain();
  await assert.rejects(stale(), { code: 'INSTANCE_ADMISSION_CLOSED' });
});

test('outbox stop awaits descendants after the run returned and cancels queued demand', async () => {
  const scope = createExecutionScope(), late = deferred(), started = deferred();
  const timers = { setInterval: () => 1, clearInterval() {}, setTimeout(fn) { this.next = fn; return 2; }, clearTimeout() { this.next = null; } };
  let calls = 0;
  const worker = createOutboxWorker(async () => {
    calls++; scope.follow('late.callback', () => late.promise); started.resolve();
  }, { scope, timers });
  await timers.next(); await started.promise;
  worker.wake(); let stopped = false;
  const closing = worker.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false); assert.equal(timers.next, null);
  worker.wake(); late.resolve(); await closing; assert.equal(calls, 1);
  await scope.drain();
});

test('reminder stop awaits the active run and its late child', async () => {
  const scope = createExecutionScope(), late = deferred(); let calls = 0, callback;
  const worker = startWorker({}, { intervalMs: 100000, taskScope: scope, drain: async () => {
    calls++; callback = scope.follow('reminder.callback', async () => {
      await late.promise;
      await assert.rejects(scope.admit('new.reminder', () => assert.fail()), { code: 'INSTANCE_ADMISSION_CLOSED' });
      assert.throws(scope.assertOpen, { code: 'INSTANCE_ADMISSION_CLOSED' });
      await scope.follow('reminder.finalization', async () => {});
    });
  } });
  await turn(); let stopped = false;
  const closing = worker.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false);
  late.resolve(); await closing; await callback; assert.equal(calls, 1); await scope.drain();
});

test('adversarial concurrent fan-out cannot hide children or admit effects after drain', async () => {
  const scope = createExecutionScope(), release = deferred(); let effects = 0;
  const work = Array.from({ length: 200 }, () => scope.admit('root', async () => {
    scope.follow('child', async () => { await release.promise; await scope.follow('sql.finish', async () => {}); });
    await release.promise;
    try { scope.assertOpen(); effects++; } catch (e) { assert.equal(e.code, 'INSTANCE_ADMISSION_CLOSED'); }
  }));
  scope.beginDrain(); assert.equal(scope.snapshot().activeCount, 400);
  for (let i = 0; i < 100; i++) await assert.rejects(scope.admitRoot('new', () => assert.fail()));
  release.resolve(); await Promise.all(work); await scope.drain();
  assert.equal(effects, 0); assert.equal(scope.snapshot().activeCount, 0);
  assert.equal(new Set(scope.snapshot().history.map(t => t.taskId)).size, scope.snapshot().history.length);
});

test('a timer context from a completed parent cannot admit work even while OPEN', async () => {
  const scope = createExecutionScope(); let stale;
  await scope.admit('parent', () => { stale = AsyncResource.bind(() => scope.follow('stale.child', () => assert.fail())); });
  assert.equal(scope.isOpen(), true);
  await assert.rejects(stale(), { code: 'INSTANCE_ADMISSION_CLOSED' });
  await scope.admitRoot('scheduler', async () => {});
  assert.equal(scope.snapshot().activeCount, 0);
});

test('outbox stop alone fences admissions and boundaries in descendants, permits finalization and leaves other workers open', async () => {
  const scope = createExecutionScope(), late = deferred(); let next, finalized = 0;
  const timers = { setInterval: () => 1, clearInterval() {}, setTimeout(fn) { next = fn; return 2; }, clearTimeout() {} };
  const worker = createOutboxWorker(async () => {
    scope.follow('original.callback', async () => {
      await late.promise;
      assert.equal(scope.isOpen(), false);
      await assert.rejects(scope.admit('new.delivery', () => assert.fail()), { code: 'INSTANCE_ADMISSION_CLOSED' });
      assert.throws(scope.assertOpen, { code: 'INSTANCE_ADMISSION_CLOSED' });
      await scope.follow('sql.finalization', async () => { finalized++; });
    });
  }, { scope, timers });
  await next();
  let stopped = false;
  const closing = worker.stop().then(() => { stopped = true; });
  await turn(); assert.equal(stopped, false);
  assert.equal(scope.isOpen(), true); // A separate worker retains its own admission.
  await scope.admitRoot('other.worker', async () => {});
  late.resolve(); await closing;
  assert.equal(finalized, 1); assert.equal(scope.snapshot().activeCount, 0);
});
