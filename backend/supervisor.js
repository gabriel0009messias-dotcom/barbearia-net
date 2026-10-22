const { fork } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { executorEnvironment } = require('./services/supervision/environment');
const { createParentBridge } = require('./services/supervision/cooperativeSealBridge');
const { VERSION, PROFILE, validate, channel } = require('./services/supervision/protocol');

// 3B.3A deliberately has NO database/issuer implementation and NO CLI activation.
function startSupervisor({ authority, environment = {}, executorDatabaseUrl, runtimeMode = 'fixture',
  heartbeatMs = 250, heartbeatTimeoutMs = 1500, handshakeTimeoutMs = 5000, onEvent = () => {} } = {}) {
  if (environment.NODE_ENV !== 'test' || authority?.localTestOnly !== true ||
      !['enrollBirth','openGate','beginDraining'].every(name => typeof authority[name] === 'function')) throw Error('3B.3A requires an explicit local test authority.');
  if (runtimeMode === 'application-test') {
    const url = new URL(executorDatabaseUrl);
    if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !/^test_[a-f0-9]{32}$/.test(environment.DATABASE_SCHEMA || '')) throw Error('Exclusive local test schema required.');
  }
  const events = new EventEmitter(), abort = new AbortController(), control = new AbortController();
  let state = 'STARTING', child, protocol, hello, ack, heartbeat, deadline, exitObservation, closed = false, pendingSends = 0, bridge, finished = false;
  let pendingHeartbeat, stoppingHeartbeat;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const session = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), spawn_id: randomUUID(),
    executor_id: null, boot_id: null, challenge: randomBytes(32).toString('hex'), runtime_profile: PROFILE,
    revision: environment.RENDER_GIT_COMMIT || null, instance_id: environment.RENDER_INSTANCE_ID || null };
  const key = randomBytes(32).toString('hex');
  const report = (type, details = {}) => { const event = Object.freeze({ type, state, ...details }); onEvent(event); events.emit('event',event); };
  const active = () => !['STOPPING','EXITED','FAILED'].includes(state);
  const send = message => {
    const pending = new Promise((resolve, reject) => {
      if (!child?.connected || pendingSends >= 8) { reject(Error('Control channel unavailable.')); return; }
      pendingSends++;
      try { child.send(message, error => { pendingSends--; if (error) reject(error); else resolve(); }); }
      catch (error) { pendingSends--; reject(error); }
    });
    pending.catch(() => failControl('ipc-send'));
    return pending;
  };
  const clear = () => { clearTimeout(deadline); clearInterval(heartbeat); };
  function failControl(reason) {
    pendingHeartbeat = stoppingHeartbeat = undefined;
    bridge?.fail();
    if (!active() && state !== 'STOPPING') return;
    const wasActive = active(); state = 'STOPPING'; abort.abort(); clear();
    if (wasActive) report('shutdown', { reason });
    report('cooperative-failed', { reason });
    if (child?.pid && !exitObservation) {
      child.kill('SIGTERM'); report('signal-forwarded');
      deadline = setTimeout(() => { if (!exitObservation) child.kill('SIGKILL'); }, handshakeTimeoutMs);
    }
  }
  function shutdown(reason = 'requested') {
    if (!active()) return;
    const cooperative = state === 'RUNNING';
    // The existing wire protocol has one outstanding heartbeat, not an echoed ID.
    // Freeze that request's sequence into a single-use, bounded shutdown allowance.
    stoppingHeartbeat = cooperative && pendingHeartbeat ? Object.freeze({
      requestSequence: pendingHeartbeat, expiresAt: performance.now() + handshakeTimeoutMs,
    }) : undefined;
    pendingHeartbeat = undefined;
    state = 'STOPPING'; abort.abort(); clear(); report('shutdown', { reason });
    // Business cancellation must never abort the control-plane draining adapter.
    Promise.resolve().then(() => authority.beginDraining({ ...session }, { signal: control.signal })).catch(() => report('drain-adapter-failed'));
    if (cooperative) {
      bridge = createParentBridge({ protocol, send });
      deadline = setTimeout(() => failControl('closure-timeout'), handshakeTimeoutMs);
      bridge.request();
    } else {
      if (protocol) send(protocol.message('STOPPING'));
      if (child?.pid && !exitObservation) { child.kill('SIGTERM'); report('signal-forwarded'); }
    }
  }
  const term = () => shutdown('SIGTERM'), interrupt = () => shutdown('SIGINT');
  function finish() { if (finished) return; finished = true; clear(); control.abort(); process.removeListener('SIGTERM',term); process.removeListener('SIGINT',interrupt); resolveDone(Object.freeze({ exit: exitObservation || null, closed, cooperativeClosed: bridge?.snapshot().state === 'CLOSED' && exitObservation?.code === 0, proof: false, stopped: false })); }
  const init = validate({ ...session, protocol_version: VERSION, message_type: 'INIT', sequence: 1, session_key: key,
    runtime_mode: runtimeMode, heartbeat_ms: heartbeatMs, heartbeat_timeout_ms: heartbeatTimeoutMs, handshake_timeout_ms: handshakeTimeoutMs });
  process.on('SIGTERM',term); process.on('SIGINT',interrupt);
  try {
    child = fork(path.join(__dirname,'executorBootstrap.js'), [], { detached: false, execArgv: [], serialization: 'json',
      env: executorEnvironment(environment,{ executorDatabaseUrl }), stdio: ['ignore','pipe','pipe','ipc'], windowsHide: true });
  } catch (error) { state = 'FAILED'; finish(); throw error; }
  child.on('spawn',() => { report('spawn', { pid: child.pid }); if (active()) send(init); else child.kill('SIGTERM'); });
  child.on('message',(message, handle) => {
    // EventEmitter does not await listeners: observe every asynchronous failure.
    receive(message,handle).catch(() => { report('protocol-rejected'); failControl('protocol'); });
  });
  async function receive(message, handle) {
    if (!active() && state !== 'STOPPING') return;
    if (handle) throw Error('IPC handles forbidden.');
    validate(message);
    if (state === 'STOPPING') {
      if (message.message_type === 'HEARTBEAT_ACK') {
        if (!bridge || !stoppingHeartbeat || performance.now() >= stoppingHeartbeat.expiresAt ||
            !['CLOSE_REQUESTED','SEALED_WAITING_ACK'].includes(bridge.snapshot().state)) throw Error('No in-flight heartbeat.');
        // Authenticated, in-order and fresh: never reuse protocol's legacy duplicate allowance.
        if (protocol.receive(message) !== 'new') throw Error('Heartbeat replay.');
        const requestSequence = stoppingHeartbeat.requestSequence;
        stoppingHeartbeat = undefined;
        // Do not emit heartbeat-ack: it updates the RUNNING liveness clock.
        report('heartbeat-drained', { requestSequence });
        return;
      }
      if (!bridge || !['COOPERATIVE_SEAL','COOPERATIVE_CLOSE_FAILED'].includes(message.message_type)) throw Error('Closure control only.');
      protocol.receive(message);
      if (await bridge.receive(message)) { clearTimeout(deadline); report('cooperative-acked'); }
      else failControl('not-certifiable');
      return;
    }
    if (!hello) {
      if (state !== 'STARTING' || message.message_type !== 'HELLO' || message.pid !== child.pid) throw Error('Wrong child.');
      const candidate = { ...session, executor_id: message.executor_id, boot_id: message.boot_id };
      protocol = channel(candidate,key,1); protocol.receive(message);
      Object.assign(session,candidate); hello = message; state = 'ENROLLING'; report('hello', { pid: child.pid });
      if (!active()) return;
      await authority.enrollBirth(Object.freeze({ ...session, observed_pid: child.pid, started_at: message.started_at }), { signal: abort.signal });
      if (!active()) return;
      report('enrolled'); if (!active()) return;
      await authority.openGate(Object.freeze({ ...session }), { signal: abort.signal });
      if (!active()) return;
      state = 'ACK_SENT'; ack = protocol.message('ACK',{ local_test_enrollment: true });
      report('before-ack'); if (!active()) return;
      send(ack); if (!active()) return; report('ack');
      if (!active()) return;
      let lastReply = performance.now();
      heartbeat = setInterval(() => {
        if (!active()) return;
        if (performance.now() - lastReply > heartbeatTimeoutMs) { shutdown('heartbeat-expired'); return; }
        if (!pendingHeartbeat) {
          const request = protocol.message('HEARTBEAT');
          pendingHeartbeat = request.sequence; send(request);
        }
      },heartbeatMs);
      events.on('heartbeat-ack',() => { pendingHeartbeat = undefined; lastReply = performance.now(); });
      return;
    }
    const disposition = protocol.receive(message);
    if (disposition === 'duplicate') { if (message.message_type === 'HELLO' && ack && active()) send(ack); return; }
    if (message.message_type === 'READY' && state === 'ACK_SENT') {
      state = 'RUNNING'; clearTimeout(deadline); report('ready',{ port: message.port });
    } else if (message.message_type === 'HEARTBEAT_ACK' && ['ACK_SENT','RUNNING'].includes(state)) { events.emit('heartbeat-ack'); report('heartbeat'); }
    else throw Error('Out of order lifecycle message.');
  }
  child.on('disconnect',() => { report('disconnect'); if (bridge?.snapshot().state !== 'CLOSED') { if (state === 'STOPPING') failControl('disconnect'); else shutdown('disconnect'); } });
  child.on('error',() => { report('child-error'); if (state === 'STOPPING') failControl('child-error'); else shutdown('child-error'); });
  const observeClosed = () => {
    if (!closed && exitObservation && !child.connected && child.stdout.destroyed && child.stderr.destroyed) {
      closed = true; report('close'); finish();
    }
  };
  child.stdout.on('close', observeClosed); child.stderr.on('close', observeClosed);
  child.on('exit',(code,signal) => { if (bridge?.snapshot().state !== 'CLOSED' || code !== 0) bridge?.fail(); exitObservation = Object.freeze({ pid: child.pid, spawn_id: session.spawn_id, code, signal }); state = 'EXITED'; clear(); report('exit',exitObservation); observeClosed(); });
  child.on('close',() => { if (closed) return; closed = true; if (!exitObservation) state = 'FAILED'; report('close'); finish(); });
  deadline = setTimeout(() => shutdown('handshake-timeout'),handshakeTimeoutMs);
  report('starting',{ pid: process.pid });
  return Object.freeze({ child, events, done, shutdown, snapshot: () => Object.freeze({ state, pid: child.pid, exit: exitObservation || null,
    spawn_id: session.spawn_id, supervisor_id: session.supervisor_id, supervisor_boot_id: session.supervisor_boot_id,
    cooperativeState: bridge?.snapshot().state || null, proof: false, stopped: false, persistentGate: false, activationBlocker: '3B_PERMISSION_SEPARATION_REQUIRED' }) });
}
module.exports = { startSupervisor };
if (require.main === module) { console.error('3B.3A is dormant: local test authority required; npm start remains unchanged.'); process.exitCode = 1; }
