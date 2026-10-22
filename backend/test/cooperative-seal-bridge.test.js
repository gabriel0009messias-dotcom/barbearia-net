const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { channel, PROFILE, validate, canonical } = require('../services/supervision/protocol');
const { createExecutionScope } = require('../services/executionScope');
const { createParentBridge, createChildBridge } = require('../services/supervision/cooperativeSealBridge');
const { startSupervisor } = require('../supervisor');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture({ drain, scope: supplied, closeAdmission } = {}) {
  const session = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), spawn_id: randomUUID(),
    executor_id: randomUUID(), boot_id: randomUUID(), challenge: randomBytes(32).toString('hex'),
    runtime_profile: PROFILE, revision: null, instance_id: null };
  const key = randomBytes(32).toString('hex'), tx = channel(session, key), rx = channel(session, key);
  const scope = supplied || createExecutionScope({ certifiable: true });
  scope.setExecutor({ executorId: session.executor_id, bootId: session.boot_id });
  const toChild = [], toParent = []; let admitted = true, closed = false, failed = false;
  const parent = createParentBridge({ protocol: tx, send: async m => { toChild.push(m); } });
  const child = createChildBridge({ protocol: rx, send: async m => { toParent.push(m); }, scope,
    closeAdmission: () => { admitted = false; return closeAdmission?.(); },
    drain: drain || (() => scope.drain({ timeoutMs: 0 })),
    onClosed: () => { closed = true; }, onFailure: () => { failed = true; } });
  const childReceive = m => { rx.receive(m); return m.message_type === 'COOPERATIVE_CLOSE_REQUEST' ? child.close(m) : child.receive(m); };
  const parentReceive = m => { tx.receive(m); return parent.receive(m); };
  return { session, key, tx, rx, scope, parent, child, toChild, toParent, childReceive, parentReceive,
    status: () => ({ admitted, closed, failed }) };
}
async function sealed(f) { f.parent.request(); await f.childReceive(f.toChild[0]); return f.toParent[0]; }

test('authenticated real scope drain, seal ownership, ACK and one-time completion', async () => {
  const f = fixture(); const response = await sealed(f);
  assert.equal(response.message_type, 'COOPERATIVE_SEAL');
  const seal = f.scope.sealClosedScope(); assert.equal(f.scope.ownsSeal(seal), true);
  assert.equal(response.seal_id, seal.seal_id); assert.equal(response.closure_generation, seal.closure_generation);
  assert.deepEqual(f.status(), { admitted: false, closed: false, failed: false });
  assert.equal(f.child.snapshot().state, 'SEALED_WAITING_ACK');
  assert.equal(await f.parentReceive(response), true);
  f.childReceive(f.toChild[1]); assert.equal(f.status().closed, true);
  assert.equal(f.parent.snapshot().state, 'CLOSED');
  assert.throws(() => f.parent.request());
  assert.throws(() => f.childReceive(f.toChild[1]));
  assert.throws(() => f.parentReceive(response));
});

test('real drain waits for descendants, obligations and mandatory capability closure before sealing', async () => {
  const f = fixture({ drain: () => f.scope.drain() }), held = deferred(); let descendant;
  f.scope.certifyProfile({ requiredCapabilities: ['listener'] });
  const capability = f.scope.registerCapability('listener'), transport = f.scope.obligation('transport');
  const root = f.scope.admit('root', () => { descendant = f.scope.follow('descendant', () => held.promise); });
  await root;
  f.parent.request(); const closing = f.childReceive(f.toChild[0]);
  assert.equal(f.status().admitted, false); assert.equal(f.toParent.length, 0);
  await assert.rejects(f.scope.admit('late', () => assert.fail()));
  held.resolve(); await descendant; await root.completion;
  assert.equal(f.toParent.length, 0); capability.close(); transport.finish();
  await closing; assert.equal(f.toParent[0].message_type, 'COOPERATIVE_SEAL');
  await f.parentReceive(f.toParent[0]); f.childReceive(f.toChild[1]); assert.equal(f.status().closed, true);
});

for (const name of ['supervisor_id', 'supervisor_boot_id', 'spawn_id', 'executor_id', 'boot_id', 'challenge', 'runtime_profile']) {
  test('authenticated response binds ' + name, async () => {
    const f = fixture(); const response = await sealed(f);
    const other = { ...f.session, [name]: name === 'challenge' ? randomBytes(32).toString('hex') : name === 'runtime_profile' ? 'other' : randomUUID() };
    const signer = channel(other, f.key);
    if (name === 'runtime_profile') { assert.throws(() => validate({ ...response, runtime_profile: 'other' })); return; }
    const payload = { closure_request_id: response.closure_request_id, closure_nonce: response.closure_nonce,
      closure_capability: response.closure_capability, seal_id: response.seal_id, closure_generation: response.closure_generation };
    assert.throws(() => f.parentReceive(signer.message('COOPERATIVE_SEAL', payload)));
    assert.equal(f.toChild.length, 1);
  });
}

for (const name of ['closure_request_id', 'closure_nonce', 'closure_capability']) {
  test('wrong ' + name + ' in authenticated seal is rejected', async () => {
    const f = fixture(); const response = await sealed(f);
    const payload = { ...response, [name]: name === 'closure_request_id' ? randomUUID() : randomBytes(32).toString('hex') };
    // Re-sign the first response at the correct sequence, so binding is tested independently of HMAC.
    const signer = channel(f.session, f.key); const fields = { ...payload };
    for (const k of [...Object.keys(f.session), 'protocol_version', 'message_type', 'sequence', 'auth']) delete fields[k];
    await assert.rejects(async () => f.parentReceive(signer.message('COOPERATIVE_SEAL', fields)));
    assert.equal(f.parent.snapshot().state, 'FAILED'); assert.equal(f.toChild.length, 1);
  });
}

test('HMAC, extra fields, size, protocol version and sequence are strict', async () => {
  for (const mutation of [m => ({ ...m, auth: '0'.repeat(64) }), m => ({ ...m, extra: true }),
    m => ({ ...m, closure_nonce: 'a'.repeat(5000) }), m => ({ ...m, protocol_version: 2 }),
    m => ({ ...m, sequence: 9 })]) {
    const f = fixture(); const response = await sealed(f);
    assert.throws(() => f.parentReceive(mutation(response))); assert.equal(f.toChild.length, 1);
  }
});

test('identical/conflicting duplicates, repeated sequence, old session and boot replay fail closed', async () => {
  for (const conflict of [false, true]) {
    const held = deferred(), f = fixture({ closeAdmission: () => held.promise });
    f.parent.request(); const request = f.toChild[0], pending = f.childReceive(request);
    assert.throws(() => f.childReceive(conflict ? { ...request, closure_nonce: '0'.repeat(64) } : request));
    f.child.fail(); held.resolve(); await pending; assert.equal(f.toParent.some(m => m.message_type === 'COOPERATIVE_SEAL'), false);
  }
  const old = fixture(); const oldSeal = await sealed(old);
  for (const name of ['challenge', 'boot_id', 'supervisor_boot_id']) {
    const next = fixture(); next.parent.request(); assert.throws(() => next.parentReceive(oldSeal), name);
  }
  const f = fixture(); const response = await sealed(f); await f.parentReceive(response);
  assert.throws(() => f.parentReceive(response));
  assert.throws(() => f.rx.receive(f.toChild[0]));
});

for (const kind of ['task', 'descendant', 'transport', 'callback', 'correlation', 'sql']) {
  test('active ' + kind + ' prevents cooperative seal', async () => {
    const f = fixture(), held = deferred(); let finish;
    if (kind === 'task') { const work = f.scope.admit('task', () => held.promise); finish = async () => { held.resolve(); await work; }; }
    else if (kind === 'descendant') {
      let child; await f.scope.admit('root', () => { child = f.scope.follow('descendant', () => held.promise); });
      finish = async () => { held.resolve(); await child; };
    } else { const obligation = f.scope.obligation(kind); finish = () => obligation.finish(); }
    const response = await sealed(f); assert.equal(response.message_type, 'COOPERATIVE_CLOSE_FAILED');
    assert.equal(f.status().admitted, false); assert.equal(f.status().failed, true);
    assert.equal(await f.parentReceive(response), false); assert.equal(f.toChild.length, 1);
    assert.equal(f.parent.snapshot().state, 'FAILED');
    assert.throws(f.scope.sealClosedScope); await finish();
  });
}

for (const reason of ['SQL_UNKNOWN', 'COMMIT_UNKNOWN', 'LATE_BLOCKER']) {
  test(reason + ' invalidates an existing seal and prevents response', async () => {
    const f = fixture(); const sql = f.scope.obligation('sql'); sql.finish(); await f.scope.drain();
    const original = f.scope.sealClosedScope(); assert.equal(f.scope.ownsSeal(original), true);
    if (reason === 'LATE_BLOCKER') f.scope.blockCertification(reason); else sql.unknown(reason);
    assert.throws(f.scope.sealClosedScope, { code: 'CERTIFICATION_BLOCKED' });
    const response = await sealed(f); assert.equal(response.message_type, 'COOPERATIVE_CLOSE_FAILED');
  });
}

test('missing mandatory capability and uncertifiable profile reject closure', async () => {
  for (const missing of [true, false]) {
    const scope = createExecutionScope({ certifiable: missing });
    if (missing) scope.certifyProfile({ requiredCapabilities: ['required'] });
    const f = fixture({ scope }); assert.equal((await sealed(f)).message_type, 'COOPERATIVE_CLOSE_FAILED');
  }
});

test('capabilities must finish and scope owns the exact seal', async () => {
  const f = fixture(); const capability = f.scope.registerCapability('listener');
  assert.equal((await sealed(f)).message_type, 'COOPERATIVE_CLOSE_FAILED'); capability.close();
  await f.scope.drain(); const seal = f.scope.sealClosedScope();
  assert.equal(f.scope.ownsSeal({ ...seal }), false);
});

test('failure during drain, disconnect while waiting ACK, and failed ACK send cannot succeed', async () => {
  const held = deferred(), f = fixture({ closeAdmission: () => held.promise });
  f.parent.request(); const pending = f.childReceive(f.toChild[0]); f.child.fail(); held.resolve(); await pending;
  assert.equal(f.toParent.some(m => m.message_type === 'COOPERATIVE_SEAL'), false);
  const g = fixture(); await sealed(g); g.child.fail();
  assert.throws(() => g.child.receive({ message_type: 'COOPERATIVE_SEAL_ACK' })); assert.equal(g.status().closed, false);
  let request;
  const protocol = channel(g.session, g.key), parent = createParentBridge({ protocol, send: async m => {
    if (m.message_type === 'COOPERATIVE_CLOSE_REQUEST') request = m;
    else throw Error('disconnect');
  } });
  parent.request();
  const response = { ...g.toParent[0], closure_request_id: request.closure_request_id,
    closure_nonce: request.closure_nonce, closure_capability: request.closure_capability };
  // Authentication belongs to channel; this directly exercises the ACK send failure.
  await assert.rejects(parent.receive(response), /disconnect/);
  assert.equal(parent.snapshot().state, 'FAILED');
});

test('a forged/non-owned seal cannot be emitted by the captured scope', async () => {
  const real = createExecutionScope({ certifiable: true });
  const f = fixture({ scope: { ...real, ownsSeal: () => false } });
  assert.equal((await sealed(f)).message_type, 'COOPERATIVE_CLOSE_FAILED');
});

for (const name of ['closure_nonce', 'closure_capability', 'seal_id', 'closure_generation']) {
  test('child rejects authenticated ACK with wrong ' + name, async () => {
    const f = fixture(); const response = await sealed(f);
    await f.parentReceive(response);
    const ack = f.toChild[1], payload = { ...ack };
    for (const k of [...Object.keys(f.session), 'protocol_version', 'message_type', 'sequence', 'auth']) delete payload[k];
    payload[name] = name === 'closure_generation' ? payload[name] + 1 : name === 'seal_id' ? randomUUID() : '0'.repeat(64);
    const signer = channel(f.session, f.key, 1);
    assert.throws(() => f.childReceive(signer.message('COOPERATIVE_SEAL_ACK', payload)));
    assert.equal(f.status().closed, false); assert.equal(f.child.snapshot().state, 'FAILED');
  });
}

test('new sequence cannot reuse consumed request id/nonce/capability', async () => {
  const f = fixture(); await sealed(f);
  const first = f.toChild[0];
  const duplicate = f.tx.message('COOPERATIVE_CLOSE_REQUEST', {
    closure_request_id: first.closure_request_id, closure_nonce: first.closure_nonce, closure_capability: first.closure_capability });
  await assert.rejects(async () => f.childReceive(duplicate));
  assert.equal(f.child.snapshot().state, 'FAILED'); assert.equal(f.status().closed, false);
});

function event(s, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Missing ' + type)), 6000);
    const listener = e => { if (e.type === type) { clearTimeout(timer); s.events.off('event', listener); resolve(e); } };
    s.events.on('event', listener);
  });
}
test('real subprocess: parent shutdown keeps control signal live, processes seal in STOPPING and waits ACK', async t => {
  let businessSignal, controlAborted;
  const authority = { localTestOnly: true, enrollBirth: async (_, { signal }) => { businessSignal = signal; },
    openGate: async () => {}, beginDraining: async (_, { signal }) => { controlAborted = signal.aborted; } };
  const s = startSupervisor({ authority, environment: { NODE_ENV: 'test' } });
  s.child.stdout.resume(); s.child.stderr.resume(); t.after(async () => { s.shutdown(); await s.done; });
  await event(s, 'ready'); const acked = event(s, 'cooperative-acked'); s.shutdown();
  assert.equal(businessSignal.aborted, true); assert.equal(s.snapshot().state, 'STOPPING');
  await acked; const done = await s.done;
  assert.equal(controlAborted, false); assert.equal(done.cooperativeClosed, true);
  assert.equal(done.proof, false); assert.equal(done.stopped, false);
});

for (const disconnect of [false, true, 'timeout']) {
  test('real child remains connected until ACK; disconnect before ACK=' + disconnect, async t => {
    const s = startSupervisor({ authority: { localTestOnly: true, enrollBirth: async () => {}, openGate: async () => {}, beginDraining: async () => {} },
      environment: { NODE_ENV: 'test' }, handshakeTimeoutMs: 3000 });
    s.child.stdout.resume(); s.child.stderr.resume(); t.after(async () => { s.shutdown(); await s.done; });
    const ready = await event(s, 'ready'), held = deferred(), send = s.child.send.bind(s.child);
    let release;
    s.child.send = (message, callback) => {
      if (message.message_type !== 'COOPERATIVE_SEAL_ACK') return send(message, callback);
      release = () => send(message, callback); held.resolve(); return true;
    };
    s.shutdown(); await held.promise;
    assert.equal(s.child.connected, true); assert.equal(s.child.exitCode, null);
    assert.equal(s.snapshot().cooperativeState, 'SEALED_WAITING_ACK');
    await assert.rejects(fetch('http://127.0.0.1:' + ready.port));
    if (disconnect === true) s.child.disconnect();
    else if (disconnect === false) { process.emit('SIGTERM'); assert.equal(s.child.connected, true); release(); }
    const done = await s.done;
    assert.equal(done.cooperativeClosed, !disconnect); assert.equal(done.proof, false);
  });
}

test('bridge stays dormant and contains no persistence or business mutation adapter', () => {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.join(__dirname, '..');
  assert.equal(require('../package.json').scripts.start, 'node app.js');
  const coordinator = require('../services/executionCapabilities').coordinator;
  assert.equal(coordinator.persistentEmissionEnabled, false);
  assert.equal(coordinator.activationBlocker, '3B_PERMISSION_SEPARATION_REQUIRED');
  for (const file of ['supervisor.js', 'executorBootstrap.js', 'services/supervision/cooperativeSealBridge.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /studiofy_(register_supervisor|register_executor_birth|advance_executor_gate|accept_executor_closure|accept_execution_stop)|INSERT\s+INTO|UPDATE\s+whatsapp_messages|abandoned_unknown|operation_token|uncertain.*pending/);
  }
  assert.equal(fs.readdirSync(path.join(root, 'database/migrations')).some(f => /^032/.test(f)), false);
});

for (const failure of ['disconnect', 'exit', 'timeout']) {
  test('real subprocess ' + failure + ' produces no cooperative success', async t => {
    const s = startSupervisor({ authority: { localTestOnly: true, enrollBirth: async () => {}, openGate: async () => {}, beginDraining: async () => {} },
      environment: { NODE_ENV: 'test' }, handshakeTimeoutMs: 2000 });
    s.child.stdout.resume(); s.child.stderr.resume(); t.after(async () => { s.shutdown(); await s.done; });
    await event(s, 'ready');
    if (failure === 'disconnect') s.child.disconnect();
    if (failure === 'exit') s.child.kill('SIGKILL');
    if (failure === 'timeout') {
      // Drop the request at the actual IPC boundary, preserving process liveness.
      const send = s.child.send.bind(s.child);
      s.child.send = (message, callback) => message.message_type === 'COOPERATIVE_CLOSE_REQUEST' ? callback() : send(message, callback);
      s.shutdown();
    }
    const done = await s.done; assert.equal(done.cooperativeClosed, false); assert.equal(done.proof, false); assert.equal(done.stopped, false);
  });
}

// Real fork/IPC, with explicit timer ticks and an ACK held at the parent's
// message boundary. No sleeps or heartbeat/close timing race is needed.
async function heartbeatPeer(t, { holdClose = false } = {}) {
  const events = [], sent = [], received = [];
  let tick, timeout, init, held = deferred(), lastChild, drainingAborted;
  const interval = global.setInterval, delay = global.setTimeout;
  t.mock.method(global, 'setInterval', (callback, ms, ...args) => {
    if (ms === 10000) tick = callback;
    return interval(callback, ms, ...args);
  });
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    if (ms === 5000) timeout = callback;
    return delay(callback, ms, ...args);
  });
  const s = startSupervisor({
    authority: { localTestOnly: true, enrollBirth: async () => {}, openGate: async () => {},
      beginDraining: async (_, { signal }) => { drainingAborted = signal.aborted; } },
    environment: { NODE_ENV: 'test' }, heartbeatMs: 10000, heartbeatTimeoutMs: 30000,
    handshakeTimeoutMs: 5000, onEvent: e => events.push(e),
  });
  s.child.stdout.resume(); s.child.stderr.resume();
  const send = s.child.send.bind(s.child), emit = s.child.emit.bind(s.child);
  s.child.send = (message, callback) => {
    sent.push(message);
    if (message.message_type === 'INIT') init = message;
    if (holdClose && message.message_type === 'COOPERATIVE_CLOSE_REQUEST') return true;
    return send(message, callback);
  };
  s.child.emit = (type, ...args) => {
    if (type === 'message') {
      lastChild = args[0]; received.push(args[0].message_type);
      if (args[0].message_type === 'HEARTBEAT_ACK') { held.resolve(args[0]); return true; }
    }
    return emit(type, ...args);
  };
  t.after(async () => { s.shutdown(); await s.done; });
  await event(s, 'ready'); assert.equal(s.snapshot().state, 'RUNNING'); assert.equal(typeof tick, 'function');
  return { s, events, sent, received,
    nextAck() { held = deferred(); tick(); return held.promise; },
    release: message => emit('message', message), tick: () => tick(), expire: () => timeout(),
    drainingAborted: () => drainingAborted,
    signedAck(source = lastChild, changes = {}) {
      // Keep the real session and fresh MAC even for adversarial sequence/binding
      // cases, so these cannot pass solely because an old MAC became invalid.
      const names = ['supervisor_id','supervisor_boot_id','spawn_id','executor_id','boot_id','challenge',
        'runtime_profile','revision','instance_id','protocol_version','sequence'];
      const message = { ...Object.fromEntries(names.map(n => [n, source[n]])), message_type: 'HEARTBEAT_ACK', ...changes };
      message.auth = createHmac('sha256', init.session_key).update(canonical(message)).digest('hex');
      return message;
    },
  };
}

test('heartbeat ACK already in flight is safely drained during cooperative STOPPING', async t => {
  const p = await heartbeatPeer(t), ack = await p.nextAck();
  const request = p.sent.find(m => m.message_type === 'HEARTBEAT');
  assert.ok(request); assert.equal(p.events.some(e => e.type === 'heartbeat'), false);
  p.s.shutdown(); assert.equal(p.s.snapshot().state, 'STOPPING');
  p.tick(); p.tick(); // Even a queued interval callback cannot send another heartbeat.
  assert.equal(p.sent.filter(m => m.message_type === 'HEARTBEAT').length, 1);
  p.release(ack);
  assert.equal(p.s.snapshot().state, 'STOPPING');
  assert.equal(p.events.filter(e => e.type === 'heartbeat-drained').length, 1);
  assert.equal(p.events.find(e => e.type === 'heartbeat-drained').requestSequence, request.sequence);
  assert.equal(p.events.some(e => e.type === 'heartbeat'), false);
  const done = await p.s.done;
  assert.equal(done.cooperativeClosed, true); assert.equal(done.proof, false); assert.equal(done.stopped, false);
  assert.equal(p.drainingAborted(), false);
  assert.ok(p.received.includes('COOPERATIVE_SEAL'));
  assert.equal(p.sent.filter(m => m.message_type === 'COOPERATIVE_SEAL_ACK').length, 1);
  assert.equal(p.events.some(e => ['protocol-rejected','cooperative-failed','signal-forwarded'].includes(e.type)), false);
  assert.equal(p.events.some(e => e.state === 'RUNNING' && e.type !== 'ready'), false);
});

test('HEARTBEAT_ACK without a pending request during STOPPING is rejected', async t => {
  const p = await heartbeatPeer(t, { holdClose: true });
  const ack = p.signedAck(undefined, { sequence: 3 }); // HELLO=1, READY=2; fresh authenticated ACK.
  assert.equal(p.sent.some(m => m.message_type === 'HEARTBEAT'), false);
  p.s.shutdown(); p.release(ack);
  const done = await p.s.done;
  assert.equal(done.cooperativeClosed, false); assert.equal(done.proof, false); assert.equal(done.stopped, false);
  assert.ok(p.events.some(e => e.type === 'protocol-rejected'));
  assert.equal(p.events.some(e => e.type === 'heartbeat-drained'), false);
});

test('duplicate in-flight heartbeat ACK during STOPPING is rejected after its one-time consumption', async t => {
  const p = await heartbeatPeer(t, { holdClose: true }), ack = await p.nextAck();
  p.s.shutdown(); p.release(ack); p.release(ack);
  const done = await p.s.done;
  assert.equal(p.events.filter(e => e.type === 'heartbeat-drained').length, 1);
  assert.ok(p.events.some(e => e.type === 'protocol-rejected')); assert.equal(done.cooperativeClosed, false);
});

test('replayed old heartbeat ACK cannot consume a different pending request during STOPPING', async t => {
  const p = await heartbeatPeer(t, { holdClose: true }), old = await p.nextAck();
  p.release(old); assert.equal(p.events.filter(e => e.type === 'heartbeat').length, 1);
  const pending = await p.nextAck(); assert.notEqual(pending.sequence, old.sequence);
  p.s.shutdown(); p.release(old);
  const done = await p.s.done;
  assert.ok(p.events.some(e => e.type === 'protocol-rejected')); assert.equal(done.cooperativeClosed, false);
  assert.equal(p.events.some(e => e.type === 'heartbeat-drained'), false);
});

for (const kind of ['HMAC', 'sequence', 'session', 'executor boot', 'supervisor boot']) {
  test('in-flight heartbeat ACK with invalid ' + kind + ' during STOPPING fails closed', async t => {
    const p = await heartbeatPeer(t, { holdClose: true }), ack = await p.nextAck();
    const changes = kind === 'sequence' ? { sequence: ack.sequence + 1 } :
      kind === 'session' ? { challenge: '0'.repeat(64) } :
      kind === 'executor boot' ? { boot_id: randomUUID() } :
      kind === 'supervisor boot' ? { supervisor_boot_id: randomUUID() } : {};
    const invalid = kind === 'HMAC' ? { ...ack, auth: '0'.repeat(64) } : p.signedAck(ack, changes);
    p.s.shutdown(); p.release(invalid);
    const done = await p.s.done;
    assert.equal(done.cooperativeClosed, false); assert.equal(done.proof, false); assert.equal(done.stopped, false);
    assert.ok(p.events.some(e => e.type === 'protocol-rejected'));
    assert.equal(p.events.some(e => e.type === 'heartbeat-drained'), false);
  });
}

test('in-flight heartbeat allowance ends with the original cooperative close deadline', async t => {
  const p = await heartbeatPeer(t, { holdClose: true }), ack = await p.nextAck();
  p.s.shutdown(); p.expire(); p.release(ack);
  const done = await p.s.done;
  assert.equal(done.cooperativeClosed, false); assert.equal(done.proof, false); assert.equal(done.stopped, false);
  assert.ok(p.events.some(e => e.type === 'cooperative-failed' && e.reason === 'closure-timeout'));
  assert.equal(p.events.some(e => e.type === 'heartbeat-drained'), false);
});
