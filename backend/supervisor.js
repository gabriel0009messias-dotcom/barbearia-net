const { fork } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { executorEnvironment } = require('./services/supervision/environment');
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
  const events = new EventEmitter(), abort = new AbortController();
  let state = 'STARTING', child, protocol, hello, ack, heartbeat, deadline, exitObservation, closed = false, pendingSends = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const session = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), spawn_id: randomUUID(),
    executor_id: null, boot_id: null, challenge: randomBytes(32).toString('hex'), runtime_profile: PROFILE,
    revision: environment.RENDER_GIT_COMMIT || null, instance_id: environment.RENDER_INSTANCE_ID || null };
  const key = randomBytes(32).toString('hex');
  const report = (type, details = {}) => { const event = Object.freeze({ type, state, ...details }); onEvent(event); events.emit('event',event); };
  const active = () => !['STOPPING','EXITED','FAILED'].includes(state);
  const send = message => {
    if (!child?.connected) { shutdown('ipc-disconnected'); return; }
    if (pendingSends >= 8) { shutdown('ipc-backpressure'); return; }
    pendingSends++;
    try { child.send(message,error => { pendingSends--; if (error) shutdown('ipc-send'); }); }
    catch { pendingSends--; shutdown('ipc-send'); }
  };
  const clear = () => { clearTimeout(deadline); clearInterval(heartbeat); };
  function shutdown(reason = 'requested') {
    if (!active()) return;
    state = 'STOPPING'; abort.abort(); clear(); report('shutdown', { reason });
    // Local state closes before signalling, even while enrollment/open awaits.
    if (protocol) send(protocol.message('STOPPING'));
    if (child?.pid && !exitObservation) { child.kill('SIGTERM'); report('signal-forwarded'); }
    Promise.resolve().then(() => authority.beginDraining({ ...session }, { signal: abort.signal })).catch(() => report('drain-adapter-failed'));
  }
  const term = () => shutdown('SIGTERM'), interrupt = () => shutdown('SIGINT');
  function finish() { clear(); process.removeListener('SIGTERM',term); process.removeListener('SIGINT',interrupt); resolveDone(Object.freeze({ exit: exitObservation || null, closed, proof: false, stopped: false })); }
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
    receive(message,handle).catch(() => { report('protocol-rejected'); shutdown('protocol'); });
  });
  async function receive(message, handle) {
    if (!active()) return;
    if (handle) throw Error('IPC handles forbidden.');
    validate(message);
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
      let awaiting = false, lastReply = performance.now();
      heartbeat = setInterval(() => {
        if (!active()) return;
        if (performance.now() - lastReply > heartbeatTimeoutMs) { shutdown('heartbeat-expired'); return; }
        if (!awaiting) { awaiting = true; send(protocol.message('HEARTBEAT')); }
      },heartbeatMs);
      events.on('heartbeat-ack',() => { awaiting = false; lastReply = performance.now(); });
      return;
    }
    const disposition = protocol.receive(message);
    if (disposition === 'duplicate') { if (message.message_type === 'HELLO' && ack && active()) send(ack); return; }
    if (message.message_type === 'READY' && state === 'ACK_SENT') {
      state = 'RUNNING'; clearTimeout(deadline); report('ready',{ port: message.port });
    } else if (message.message_type === 'HEARTBEAT_ACK' && ['ACK_SENT','RUNNING'].includes(state)) { events.emit('heartbeat-ack'); report('heartbeat'); }
    else throw Error('Out of order lifecycle message.');
  }
  child.on('disconnect',() => { report('disconnect'); shutdown('disconnect'); });
  child.on('error',() => { report('child-error'); shutdown('child-error'); });
  child.on('exit',(code,signal) => { exitObservation = Object.freeze({ pid: child.pid, spawn_id: session.spawn_id, code, signal }); state = 'EXITED'; clear(); report('exit',exitObservation); });
  child.on('close',() => { closed = true; if (!exitObservation) state = 'FAILED'; report('close'); finish(); });
  deadline = setTimeout(() => shutdown('handshake-timeout'),handshakeTimeoutMs);
  report('starting',{ pid: process.pid });
  return Object.freeze({ child, events, done, shutdown, snapshot: () => Object.freeze({ state, pid: child.pid, exit: exitObservation || null,
    spawn_id: session.spawn_id, supervisor_id: session.supervisor_id, supervisor_boot_id: session.supervisor_boot_id,
    proof: false, stopped: false, persistentGate: false, activationBlocker: '3B_PERMISSION_SEPARATION_REQUIRED' }) });
}
module.exports = { startSupervisor };
if (require.main === module) { console.error('3B.3A is dormant: local test authority required; npm start remains unchanged.'); process.exitCode = 1; }
