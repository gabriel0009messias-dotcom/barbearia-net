// Separate mandatory gate: node --test test/sql031-adversarial-signals.linux.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processFixture, signalParent, assertObservedExit } = require('./helpers/sql031AdversarialFixtures');
assert.equal(process.platform, 'linux', 'This gate requires real Linux signals');
assert.equal(process.version, 'v20.20.1', 'Use the approved Linux runtime');

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test('K01: real child ' + signal + ', kill request and exit never produce automatic STOPPED', { timeout: 20000 }, async t => {
    const f = processFixture(t); await f.event('ready');
    assert.equal(f.s.child.kill(signal), true); assert.equal(f.s.child.killed, true);
    assert.equal(f.s.snapshot().exit, null); assert.equal(f.s.snapshot().proof, false);
    const result = await f.s.done;
    assert.ok(result.exit); assert.equal(result.proof, false); assert.equal(result.stopped, false);
    assert.equal(f.calls.includes('FORBIDDEN_PROOF'), false);
    assertObservedExit(f);
    if (signal === 'SIGKILL') assert.equal(result.exit.signal, 'SIGKILL');
    // SIGTERM may be handled cooperatively; observe the actual exit without inventing a signal exit code.
    assert.ok(result.exit.code !== null || result.exit.signal !== null);
  });
}

test('K01: real supervisor SIGTERM drains without inventing cooperative SQL proof', { timeout: 25000 }, async t => {
  const p = signalParent(t); const ready = await p.event('ready');
  assert.equal((await fetch('http://127.0.0.1:' + ready.port)).status, 200);
  p.child.kill('SIGTERM'); await p.done;
  assert.match(p.output(), /DONE .*"proof":false/); assert.match(p.output(), /DONE .*"stopped":false/);
  const events = p.output().split('\n').filter(l => l.startsWith('PARENT ')).map(l => JSON.parse(l.slice(7)));
  assert.ok(events.some(e => e.type === 'shutdown' && e.reason === 'SIGTERM'));
  const spawned = events.find(e => e.type === 'spawn'), exited = events.find(e => e.type === 'exit');
  assert.ok(spawned && exited); assert.equal(exited.pid, spawned.pid);
  const wire = p.output().split('\n').filter(l => l.startsWith('WIRE ')).map(l => JSON.parse(l.slice(5)));
  assert.ok(wire.some(m => m.type === 'COOPERATIVE_CLOSE_REQUEST'));
  assert.equal(wire.some(m => ['STOPPED', 'SQL031_CLOSURE', 'EXECUTION_STOP'].includes(m.type)), false);
  await assert.rejects(fetch('http://127.0.0.1:' + ready.port));
});

test('K01: parent SIGKILL disconnects real child; whole-instance loss remains no proof', { timeout: 25000 }, async t => {
  const p = signalParent(t); const ready = await p.event('ready');
  const response = await fetch('http://127.0.0.1:' + ready.port), health = await response.json();
  // Teardown may kill only the child PID returned by this isolated fixture.
  t.after(async () => {
    // Never signal a stale PID after its original listener has disappeared.
    let current;
    try { current = await (await fetch('http://127.0.0.1:' + ready.port)).json(); } catch { return; }
    assert.equal(current.pid, health.pid);
    try { process.kill(health.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  });
  p.child.kill('SIGKILL'); const result = await p.done; assert.equal(result.signal, 'SIGKILL');
  let closed = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch('http://127.0.0.1:' + ready.port); }
    catch { closed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(closed, true, 'Child must withdraw its listener after losing parent');
  assert.doesNotMatch(p.output(), /"proof":true|"stopped":true/);
  assert.ok(Number.isInteger(health.pid)); assert.notEqual(health.pid, p.child.pid);
  assert.match(p.output(), /WIRE .*"type":"READY"/);
});

// PROCESS EVIDENCE: real signals, exit observations, IPC types and listener withdrawal.
// No real cooperative SQL/STOP seam is exposed here. Constant flags and optional sentinels
// do not certify persistence; PostgreSQL/lifecycle assertions are a separate gate.
