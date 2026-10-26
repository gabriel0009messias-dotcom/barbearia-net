const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processFixture, assertObservedExit } = require('./helpers/sql031AdversarialFixtures');

const noStop = f => {
  assert.equal(f.s.snapshot().proof, false); assert.equal(f.s.snapshot().stopped, false);
  assert.equal(f.s.snapshot().persistentGate, false);
  assert.equal(f.s.snapshot().activationBlocker, '3B_PERMISSION_SEPARATION_REQUIRED');
  assert.equal(f.calls.includes('FORBIDDEN_PROOF'), false);
};

test('G02/K01: real IPC disconnect closes admission without creating closure/proof authority', { timeout: 20000 }, async t => {
  const f = processFixture(t); const ready = await f.event('ready');
  const body = await (await fetch('http://127.0.0.1:' + ready.port)).json();
  assert.equal(body.effects.database, 0); assert.equal(body.effects.migration, 0);
  f.s.child.disconnect(); noStop(f);
  const result = await f.s.done; assert.equal(result.proof, false); assert.equal(result.stopped, false);
  assertObservedExit(f); assert.ok(f.events.some(e => e.type === 'disconnect'));
  await assert.rejects(fetch('http://127.0.0.1:' + ready.port)); noStop(f);
});

test('G02/K01: child error/socket close notification cannot substitute for observed process exit', { timeout: 20000 }, async t => {
  const f = processFixture(t); await f.event('ready');
  f.s.child.emit('error', Error('Synthetic socket/connection failure notification'));
  assert.equal(f.s.snapshot().exit, null); noStop(f);
  const result = await f.s.done; assert.ok(result.exit); assert.equal(result.proof, false); noStop(f);
  assertObservedExit(f); assert.ok(f.events.some(e => e.type === 'child-error'));
});

test('G02: real restart and synthetic revision replacement cannot inherit proof or execution identity', { timeout: 30000 }, async t => {
  const births = [];
  for (const revision of ['synthetic-revision-a', 'synthetic-revision-b']) {
    const f = processFixture(t, { environment: { RENDER_GIT_COMMIT: revision } });
    await f.event('ready');
    const birth = f.calls.find(x => x.kind === 'birth').record; births.push(birth);
    assert.equal(birth.revision, revision); noStop(f);
    f.s.shutdown(); const result = await f.s.done;
    assert.equal(result.proof, false); assert.equal(result.stopped, false); noStop(f);
    assertObservedExit(f); assert.ok(f.events.some(e => e.type === 'shutdown' && e.reason === 'requested'));
  }
  for (const key of ['executor_id', 'boot_id', 'supervisor_id', 'supervisor_boot_id', 'spawn_id']) {
    assert.notEqual(births[0][key], births[1][key], key);
  }
});

test('A01/G02: child cannot turn an unauthenticated IPC notification into parent SQL authority', { timeout: 20000 }, async t => {
  const f = processFixture(t); await f.event('ready');
  const callsBefore = [...f.calls], eventsBefore = f.events.length;
  assert.equal(f.adversarialInputs.length, 0);
  f.injectAdversarialMessage({ message_type: 'STOPPED', proof_type: 'COOPERATIVE_SCOPE_CLOSED', subjects: [] });
  assert.equal(f.adversarialInputs.length, 1);
  const input = f.adversarialInputs[0];
  assert.equal(input.type, 'STOPPED'); assert.equal(input.direction, 'child-to-parent');
  assert.equal(input.origin, 'test-adversarial-input'); assert.ok(f.wire.includes(input));
  const result = await f.s.done; assert.equal(result.proof, false); noStop(f);
  assert.ok(f.events.some(e => e.type === 'protocol-rejected'));
  const consequences = f.events.slice(eventsBefore);
  assert.ok(consequences.some(e => e.type === 'protocol-rejected'));
  assert.ok(consequences.some(e => e.type === 'cooperative-failed' && e.reason === 'protocol'));
  assert.equal(consequences.some(e => e.type === 'cooperative-acked'), false);
  assert.equal(f.s.snapshot().cooperativeState, null); assert.equal(result.cooperativeClosed, false);
  assert.deepEqual(f.calls, callsBefore); assert.equal(f.adversarialInputs.length, 1);
  const supervisorOutput = f.wire.filter(m => m.direction === 'parent-to-child');
  assert.equal(supervisorOutput.some(m => ['STOPPED', 'SQL031_CLOSURE', 'EXECUTION_STOP'].includes(m.type)), false);
  assert.equal(f.wire.some(m => m !== input && ['STOPPED', 'SQL031_CLOSURE', 'EXECUTION_STOP'].includes(m.type)), false);
  assertObservedExit(f);
});

// These are negative tests of the existing process boundary. There is deliberately
// no adapter translating IPC seal_id into synthetic zero counters or SQL receipts.
// proof/stopped/persistentGate are constant contract checks, not persistence evidence.
// The optional forbidden authority callbacks are sentinels, not an existing SQL seam.
// assertObservedExit adds actual PID/exit/enrollment/IPC evidence. SQL lifecycle is tested separately in PG.
