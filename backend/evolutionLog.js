const PUBLIC_ERROR_CODES = new Set([
  "WHATSAPP_BUSY",
  "WHATSAPP_METHOD_PENDING",
  "EVOLUTION_ERROR",
  "EVOLUTION_NOT_CONFIGURED",
  "EVOLUTION_INVALID_URL",
  "EVOLUTION_INSTANCE_EXISTS",
  "EVOLUTION_INVALID_KEY",
  "EVOLUTION_OFFLINE",
  "EVOLUTION_TIMEOUT",
  "EVOLUTION_RATE_LIMIT",
  "EVOLUTION_ALREADY_DISCONNECTED",
  "EVOLUTION_INSTANCE_NOT_FOUND",
  "EVOLUTION_ENDPOINT_NOT_FOUND",
  "EVOLUTION_CREATE_FAILED",
  "EVOLUTION_CONNECT_FAILED",
  "EVOLUTION_REQUEST_FAILED",
  "EVOLUTION_INVALID_RESPONSE",
  "EVOLUTION_DNS_ERROR",
  "WHATSAPP_AUTH_REQUIRED",
  "EVOLUTION_STATE_UNKNOWN",
  "EVOLUTION_PAIRING_FAILED",
  "WHATSAPP_INTERNAL_ERROR",
  "SUBSCRIPTION_BLOCKED",
  "WHATSAPP_NOT_STARTED",
  "INVALID_PHONE",
  "SUBSCRIPTION_NOT_FOUND",
  "WHATSAPP_LOCAL_START_FAILED"
]);
// Untrusted text has no safe default. Retain only operational formats/constants.
const OMITTED = '[REDACTED]';
const PUBLIC_MESSAGES = new Set(['too many requests','bad request','unauthorized','forbidden','not found','internal server error','bad gateway','service unavailable','gateway timeout']);
const CONSTANTS = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','Error','TypeError','AbortError','TimeoutError','upstream','local_cooldown','low','high','no_upstream_response','studiofy_local_cooldown','upstream_application_or_intermediary','upstream_response_without_safe_details','cloudflare_in_path','render_in_path','proxy_in_path','rate_limit_headers_present','section_open','manual_status','connect_click','poll','logout_click','unspecified','open','close','connecting','connected','disconnected','qr','pairing','ENOTFOUND','ECONNREFUSED','ECONNRESET','CERT_HAS_EXPIRED','ETIMEDOUT']);
const EVENTS = new Set(['request_start','request_response','request_failure','failure','rate_limit','evolution_upstream_429','evolution_temporary_upstream_error','connection_code_recovery','connection_start','status_cache_hit','instance_absent','test_error','STATUS_REQUEST_RECEIVED','STATUS_CALLING_EVOLUTION','STATUS_EVOLUTION_RESPONSE']);
for (const event of ['STATUS_BLOCKED_BY_LOCAL_COOLDOWN','diagnostic_url','diagnostic_dns_ok','diagnostic_dns_error','diagnostic_start','diagnostic_result','webhook_ignored','webhook_connection_update','webhook_qrcode_updated']) EVENTS.add(event);
for (const event of ['QRCODE_UPDATED','CONNECTION_UPDATE','evento de conexao recebido','resposta enviada','mensagem recebida','erro de envio; resposta preservada para nova tentativa','erro de processamento da fila']) EVENTS.add(event);
const NUMBERS = new Set(['attempt','timeoutMs','httpStatus','statusCode','upstreamStatus','durationMs','ageMs','retryAfterSeconds','retryAt','localBackoffSeconds','backoffSeconds','effectiveSeconds','effectiveRetryAfterSeconds','codeExpiresInSeconds','assinaturaId','accountId','salonId']);
const KEYS = new Set(['event','timestamp','requestId','action','trigger','endpoint','path','instanceName','instance','method','origin','error','context','diagnostic','rateLimitSource','body','bodyTruncated','bodyOmitted','upstreamRetryAfter','studiofyCooldown','statusText','hasQr','hasPairingCode','fields','status','name','message','stack','errorCode','cause','details','errors','classification','probableOrigin','confidence','evidence','producerConfirmed',...NUMBERS]);
NUMBERS.add('tenant'); KEYS.add('tenant'); KEYS.add('state');
function containsEnvironmentSecret(text) {
  return Object.entries(process.env).some(([key,value]) => /key|secret|token|password|senha|authorization|credential|database.*(?:url|uri)/i.test(key) && value && text.includes(value));
}
for (const header of ['retry-after','content-type','server','via','cf-ray','cf-cache-status','date','x-request-id','request-id','rndr-id',
  'x-render-origin-server','x-render-routing','x-render-request-id','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset',
  'x-ratelimit-policy','x-ratelimit-reset-after','ratelimit','ratelimit-policy','ratelimit-limit','ratelimit-remaining','ratelimit-reset']) KEYS.add(header);
function safeText(value, field = '') {
  const text = String(value);
  if (containsEnvironmentSecret(text)) return OMITTED;
  if (['body','message','statusText'].includes(field) && PUBLIC_MESSAGES.has(text.toLowerCase())) return text;
  if (['method','name','rateLimitSource','probableOrigin','confidence','evidence','trigger','status','state','errorCode'].includes(field) && CONSTANTS.has(text)) return text;
  if (field === 'upstreamRetryAfter' && /^(?:0|[1-9]\d{0,4})$/.test(text) && Number(text) <= 86400) return text;
  if (field === 'upstreamRetryAfter' && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(Date.parse(text)).toUTCString() === text) return text;
  if (/^\[BODY OMITTED: (?:non-public content|size limit|read timeout|read failure)\]$/.test(text) || text === OMITTED || text === '[VALUE OMITTED]') return text;
  if (field === 'event' && EVENTS.has(text)) return text;
  if (field === 'errorCode' && PUBLIC_ERROR_CODES.has(text)) return text;
  if (field === 'requestId' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) return text;
  if (field === 'timestamp' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text))) return text;
  if (['instance','instanceName'].includes(field) && /^(?:barbearia-\d+|[a-z-]{1,7})$/.test(text)) return text;
  if (['endpoint','path'].includes(field) && /^\/(?:instance\/(?:connect|connectionState|create|logout|delete|fetchInstances)|webhook\/(?:set|find))(?:\/(?:barbearia-\d+|[a-z-]{1,7}|(?:test|diagnostic)-\d+))?$/.test(text)) return text;
  if (field === 'origin') for (const key of ['EVOLUTION_API_URL','EVOLUTION_URL']) {
    try { const origin = new URL(process.env[key]).origin; if (text === origin) return origin; } catch { /* no configured origin */ }
  }
  return OMITTED;
}
function sanitize(value, seen = new WeakSet(), field = '') {
  if (typeof value === 'string') return safeText(value,field);
  if (typeof value === 'number') return NUMBERS.has(field) && Number.isFinite(value) && value >= 0 ? value : OMITTED;
  if (!value || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return OMITTED;
  if (seen.has(value)) return '[Circular]'; seen.add(value);
  if (value instanceof Error) return sanitize({name:value.name,message:value.message,stack:OMITTED,errorCode:value.code,statusCode:value.statusCode,upstreamStatus:value.upstreamStatus,rateLimitSource:value.rateLimitSource,retryAfterSeconds:value.retryAfterSeconds,retryAt:value.retryAt,cause:value.cause,details:OMITTED},seen);
  if (Array.isArray(value)) return value.map(item=>sanitize(item,seen,field));
  return Object.fromEntries(Object.entries(value).map(([key,item])=>KEYS.has(key)?[key,sanitize(item,seen,key)]:['[OMITTED FIELD]',OMITTED]));
}
function sanitizeUpstreamBody(raw) { return {body:safeText(raw,'body'),bodyTruncated:String(raw).length>1000}; }
function logEvolution(event,data={},level='info') {
  const safe=sanitize({timestamp:new Date().toISOString(),...require('./evolutionContext').current(),event,...data});
  console[level==='error'?'error':'info']('[Evolution API]',JSON.stringify(safe));
}
module.exports={logEvolution,sanitize,sanitizeUpstreamBody,safeText,PUBLIC_ERROR_CODES};
