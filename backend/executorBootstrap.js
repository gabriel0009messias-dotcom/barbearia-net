const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { validate, channel } = require('./services/supervision/protocol');
const boundary = require('./services/supervision/context');

// This entrypoint is not npm start. No app/database/business imports before ACK.
function runExecutor({ transport = process, startRuntime = startLocalTestRuntime, onEvent = () => {},
  schemaAlreadyPrepared = () => { throw Error('Prepared schema authority is not configured.'); } } = {}) {
  const identity = Object.freeze({ executorId: randomUUID(), bootId: randomUUID(), processId: process.pid,
    startedAt: new Date(performance.timeOrigin).toISOString(), serviceId: process.env.RENDER_SERVICE_ID || null,
    deploymentId: null, instanceId: process.env.RENDER_INSTANCE_ID || null, revision: process.env.RENDER_GIT_COMMIT || null });
  let state = 'WAIT_INIT', protocol, init, runtime, startup, timer, deadline, lastHeartbeat, stopped, pendingSends = 0;
  const gate = boundary.install({ identity, schemaAlreadyPrepared,
    confirmEnrollment: async () => { gate.value.assertOpen(); if (!init || state !== 'RUNNING') throw Error('No enrollment confirmation.'); return identity; } });
  const report = (type, details = {}) => onEvent(Object.freeze({ type, state, ...details }));
  const send = message => {
    if (!transport.connected) { stop('disconnect'); return; }
    if (pendingSends >= 8) { stop('ipc-backpressure'); return; }
    pendingSends++;
    try { transport.send(message,error => { pendingSends--; if (error) stop('ipc-send'); }); }
    catch { pendingSends--; stop('ipc-send'); }
  };
  const closing = () => ['STOPPING','CLOSED'].includes(state);
  function stop(reason) {
    if (closing()) return stopped;
    state = 'STOPPING'; const runtimeClosing = gate.close(); clearTimeout(deadline); clearInterval(timer); report('admission-closed',{ reason });
    stopped = Promise.resolve(startup).catch(() => {}).then(async () => {
      await runtime?.stop?.();
      await runtimeClosing;
      state = 'CLOSED'; report('closed');
      transport.removeListener('message',receive);
      transport.removeListener('disconnect',disconnected);
      process.removeListener('SIGTERM',term); process.removeListener('SIGINT',interrupt);
      if (transport.connected) transport.disconnect();
    }).catch(() => { process.exitCode = 1; if (transport.connected) transport.disconnect(); });
    return stopped;
  }
  const term = () => stop('SIGTERM'), interrupt = () => stop('SIGINT'), disconnected = () => stop('disconnect');
  process.on('SIGTERM',term); process.on('SIGINT',interrupt); transport.on('disconnect',disconnected);
  gate.setReady(port => { if (!closing()) send(protocol.message('READY',{ port })); });
  function receive(message, handle) {
    if (closing()) return;
    try {
      if (handle) throw Error('IPC handles forbidden.');
      validate(message);
      if (state === 'WAIT_INIT') {
        if (message.message_type !== 'INIT' || message.sequence !== 1 || process.env.NODE_ENV !== 'test' ||
          message.revision !== identity.revision || message.instance_id !== identity.instanceId) throw Error('Invalid local bootstrap.');
        init = message;
        clearTimeout(deadline);
        deadline = setTimeout(() => { process.exitCode = 1; stop('handshake-timeout'); },init.handshake_timeout_ms);
        require('./services/supervision/profile').installSingleProcessProfile();
        const session = {};
        for (const name of ['supervisor_id','supervisor_boot_id','spawn_id','challenge','runtime_profile','revision','instance_id']) session[name] = init[name];
        session.executor_id = identity.executorId; session.boot_id = identity.bootId;
        protocol = channel(session,init.session_key,0,1);
        state = 'WAIT_ACK';
        send(protocol.message('HELLO',{ pid: process.pid, started_at: identity.startedAt }));
        report('hello');
        return;
      }
      if (protocol.receive(message) === 'duplicate') return;
      if (message.message_type === 'STOPPING') { stop('parent-stopping'); return; }
      if (message.message_type === 'ACK' && state === 'WAIT_ACK') {
        // All checks and grant are synchronous; shutdown is irreversible.
        if (closing()) return;
        gate.open(); state = 'RUNNING'; clearTimeout(deadline); lastHeartbeat = performance.now();
        timer = setInterval(() => { if (performance.now() - lastHeartbeat > init.heartbeat_timeout_ms) stop('heartbeat-expired'); },init.heartbeat_ms);
        report('ack');
        startup = Promise.resolve().then(() => {
          gate.value.assertOpen();
          return startRuntime({ mode: init.runtime_mode, context: gate.value });
        }).then(value => { runtime = value; if (closing()) return runtime?.stop?.(); }).catch(() => { process.exitCode = 1; stop('runtime-failed'); });
      } else if (message.message_type === 'HEARTBEAT' && state === 'RUNNING') {
        lastHeartbeat = performance.now(); send(protocol.message('HEARTBEAT_ACK')); report('heartbeat');
      } else throw Error('Out of order bootstrap message.');
    } catch { process.exitCode = 1; report('protocol-rejected'); stop('protocol'); }
  }
  transport.on('message',receive);
  // Only a control deadline exists before INIT/ACK. No business modules loaded.
  deadline = setTimeout(() => { process.exitCode = 1; stop('handshake-timeout'); },10000);
  report('bootstrap');
  return Object.freeze({ stop, snapshot: () => Object.freeze({ state, admitted: gate.value.isOpen(), identity, proof: false, stopped: false }) });
}
function startLocalTestRuntime({ mode, context }) {
  context.assertOpen();
  if (mode === 'fixture') return require('./test/helpers/supervisedRuntime').start(context);
  if (mode !== 'application-test') throw Error('No production adapter in 3B.3A.');
  // Full app integration is possible only with a preprepared local test schema.
  const url = new URL(process.env.DATABASE_URL);
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || !/^test_[a-f0-9]{32}$/.test(process.env.DATABASE_SCHEMA || '')) throw Error('Exclusive test database required.');
  require('./app');
  return { stop: () => require('./services/executionCapabilities').coordinator.drain() };
}
module.exports = { runExecutor };
if (require.main === module) runExecutor({
  schemaAlreadyPrepared: pool => require('./services/supervision/preparedSchema').verifyPreparedSchema(pool),
  onEvent: event => console.log('SUPERVISION ' + JSON.stringify(event)),
});
