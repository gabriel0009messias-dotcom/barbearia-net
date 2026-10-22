const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const VERSION = 1, PROFILE = 'evolution-single-process-v1', MAX_BYTES = 4096;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hex = /^[a-f0-9]{64}$/;
const common = ['protocol_version','message_type','supervisor_id','supervisor_boot_id','spawn_id','executor_id','boot_id',
  'sequence','challenge','runtime_profile','revision','instance_id'];
const fields = Object.freeze({ INIT: ['session_key','runtime_mode','heartbeat_ms','heartbeat_timeout_ms','handshake_timeout_ms'],
  HELLO: ['pid','started_at'], ACK: ['local_test_enrollment'], READY: ['port'], HEARTBEAT: [], HEARTBEAT_ACK: [], STOPPING: [],
  COOPERATIVE_CLOSE_REQUEST: ['closure_request_id','closure_nonce','closure_capability'],
  COOPERATIVE_SEAL: ['closure_request_id','closure_nonce','closure_capability','seal_id','closure_generation'],
  COOPERATIVE_SEAL_ACK: ['closure_request_id','closure_nonce','closure_capability','seal_id','closure_generation'],
  COOPERATIVE_CLOSE_FAILED: ['closure_request_id','closure_nonce','closure_capability','failure_code'] });
const invalid = () => Object.assign(Error('Invalid supervision protocol.'), { code: 'SUPERVISION_PROTOCOL_INVALID' });
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function validate(message) {
  if (!message || Object.getPrototypeOf(message) !== Object.prototype) throw invalid();
  const extra = fields[message.message_type];
  if (!extra || Buffer.byteLength(canonical(message)) > MAX_BYTES) throw invalid();
  const expected = [...common, ...extra, ...(message.message_type === 'INIT' ? [] : ['auth'])];
  if (Object.keys(message).length !== expected.length || expected.some(key => !Object.hasOwn(message,key))) throw invalid();
  if (message.protocol_version !== VERSION || message.runtime_profile !== PROFILE || !hex.test(message.challenge) ||
      !Number.isSafeInteger(message.sequence) || message.sequence < 1) throw invalid();
  for (const key of ['supervisor_id','supervisor_boot_id','spawn_id']) if (!uuid.test(message[key])) throw invalid();
  for (const key of ['executor_id','boot_id']) if (message.message_type === 'INIT' ? message[key] !== null : !uuid.test(message[key])) throw invalid();
  for (const key of ['revision','instance_id']) if (message[key] !== null && (typeof message[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(message[key]))) throw invalid();
  if (message.message_type !== 'INIT' && !hex.test(message.auth)) throw invalid();
  if (message.message_type === 'INIT') {
    if (!hex.test(message.session_key) || !['fixture','application-test'].includes(message.runtime_mode)) throw invalid();
    for (const key of ['heartbeat_ms','heartbeat_timeout_ms','handshake_timeout_ms']) if (!Number.isSafeInteger(message[key]) || message[key] < 10 || message[key] > 60000) throw invalid();
    if (message.heartbeat_timeout_ms < message.heartbeat_ms * 3) throw invalid();
  }
  if (message.message_type === 'HELLO' && (!Number.isSafeInteger(message.pid) || message.pid <= 0 || typeof message.started_at !== 'string' || !Number.isFinite(Date.parse(message.started_at)))) throw invalid();
  if (message.message_type === 'ACK' && message.local_test_enrollment !== true) throw invalid();
  if (message.message_type === 'READY' && (!Number.isSafeInteger(message.port) || message.port < 0 || message.port > 65535)) throw invalid();
  if (message.message_type.startsWith('COOPERATIVE_')) {
    if (!uuid.test(message.closure_request_id) || !hex.test(message.closure_nonce) || !hex.test(message.closure_capability)) throw invalid();
    if (['COOPERATIVE_SEAL','COOPERATIVE_SEAL_ACK'].includes(message.message_type) &&
        (!uuid.test(message.seal_id) || !Number.isSafeInteger(message.closure_generation) || message.closure_generation < 1)) throw invalid();
    if (message.message_type === 'COOPERATIVE_CLOSE_FAILED' && message.failure_code !== 'NOT_CERTIFIABLE') throw invalid();
  }
  return message;
}
function authenticate(message, key) {
  const body = { ...message }; delete body.auth;
  return createHmac('sha256',key).update(canonical(body)).digest('hex');
}
function channel(session, key, initialSent = 0, initialReceived = 0) {
  let sent = initialSent, received = initialReceived, previous;
  return Object.freeze({
    message(type, extra = {}) {
      const m = { ...session, protocol_version: VERSION, message_type: type, sequence: ++sent, ...extra };
      m.auth = authenticate(m,key); validate(m); return Object.freeze(m);
    },
    receive(message) {
      validate(message);
      if (message.message_type === 'INIT') throw invalid();
      for (const name of common.filter(n => !['protocol_version','message_type','sequence'].includes(n))) if (message[name] !== session[name]) throw invalid();
      if (!timingSafeEqual(Buffer.from(message.auth,'hex'),Buffer.from(authenticate(message,key),'hex'))) throw invalid();
      const hash = createHash('sha256').update(canonical(message)).digest('hex');
      if (message.sequence === received && hash === previous) {
        if (message.message_type.startsWith('COOPERATIVE_')) throw invalid();
        return 'duplicate';
      }
      if (message.sequence !== received + 1) throw invalid();
      received = message.sequence; previous = hash; return 'new';
    },
  });
}
module.exports = { VERSION, PROFILE, MAX_BYTES, validate, channel, canonical, invalid };
