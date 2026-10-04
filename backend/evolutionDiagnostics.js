// Temporary diagnostics: never serialize request headers, payloads or Error objects.
const { sanitizeUpstreamBody, sanitize } = require('./evolutionLog');
const SAFE_HEADERS = Object.freeze([
  'retry-after', 'content-type', 'server', 'via', 'cf-ray', 'cf-cache-status',
  'date', 'x-request-id', 'request-id', 'rndr-id',
  // Explicit Render names only: an arbitrary X-Render-* header can contain secrets.
  'x-render-origin-server', 'x-render-routing', 'x-render-request-id',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'x-ratelimit-policy', 'x-ratelimit-reset-after', 'ratelimit',
  'ratelimit-policy', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
]);
const BODY_LIMIT = 256;
const READ_LIMIT = 8192;
const PUBLIC_MESSAGES = new Set([
  'too many requests', 'bad request', 'unauthorized', 'forbidden', 'not found',
  'internal server error', 'bad gateway', 'service unavailable', 'gateway timeout',
]);

function safeValue(value) {
  return sanitizeUpstreamBody(String(value)).body.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 256);
}

function safeHeaders(headers) {
  const result = {};
  for (const name of SAFE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) result[name] = safeValue(value);
  }
  return result;
}

function safeBody(raw) {
  // Regex redaction cannot prove arbitrary response text is free of private data.
  // Only canonical public error phrases are retained; arbitrary JSON/HTML is omitted.
  let candidate = raw.trim();
  try {
    const parsed = JSON.parse(raw);
    candidate = typeof parsed === 'string' ? parsed : parsed?.message || parsed?.error || parsed?.response?.message;
    if (Array.isArray(candidate) && candidate.length === 1) candidate = candidate[0];
  } catch { /* plain text */ }
  const publicMessage = typeof candidate === 'string' && PUBLIC_MESSAGES.has(candidate.toLowerCase());
  return {
    body: publicMessage ? safeValue(candidate).slice(0, BODY_LIMIT) : '[BODY OMITTED: non-public content]',
    bodyTruncated: raw.length > BODY_LIMIT,
    bodyOmitted: !publicMessage,
  };
}

async function readSafeBody(response) {
  let reader, timer;
  try {
    reader = response.body?.getReader();
    if (!reader) return { body: '', bodyTruncated: false, bodyOmitted: false };
    const read = async () => {
      let size = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) return safeBody(Buffer.concat(chunks).toString('utf8'));
        size += value.byteLength;
        if (size > READ_LIMIT) return { body: '[BODY OMITTED: size limit]', bodyTruncated: true, bodyOmitted: true };
        chunks.push(Buffer.from(value));
      }
    };
    return await Promise.race([read(), new Promise(resolve => {
      timer = setTimeout(() => resolve({ body: '[BODY OMITTED: read timeout]', bodyTruncated: true, bodyOmitted: true }), 1000);
    })]);
  } catch {
    return { body: '[BODY OMITTED: read failure]', bodyTruncated: true, bodyOmitted: true };
  } finally {
    clearTimeout(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

function classifyOrigin(headers, status) {
  const evidence = [];
  if (headers['cf-ray'] || /cloudflare/i.test(headers.server || '')) evidence.push('cloudflare_in_path');
  if (headers['rndr-id'] || Object.keys(headers).some(name => name.startsWith('x-render-'))) evidence.push('render_in_path');
  if (headers.via) evidence.push('proxy_in_path');
  if (Object.keys(headers).some(name => /^(?:x-)?ratelimit/.test(name))) evidence.push('rate_limit_headers_present');
  return { probableOrigin: status === 429 ? 'upstream_application_or_intermediary' : 'upstream',
    confidence: 'low', evidence, producerConfirmed: false };
}

async function responseDiagnostic(response, context, started) {
  const headers = safeHeaders(response.headers);
  const body = await readSafeBody(response);
  return { ...sanitize({ httpStatus: response.status, statusText: safeValue(response.statusText || ''),
    requestId: context.requestId, timestamp: new Date().toISOString(),
    method: context.method, endpoint: context.endpoint, origin: context.origin,
    durationMs: Math.max(0, Date.now() - started),
    upstreamRetryAfter: headers['retry-after'] ?? null, ...body,
    classification: classifyOrigin(headers, response.status) }), headers: sanitize(headers),
    origin: sanitize(context.origin).replace(/\/$/, '') };
}

function routeDiagnostic(error) {
  // Only the module's explicit projection can reach the browser; no stack/details.
  if (error.upstreamDiagnostic && error.rateLimitSource !== 'local_cooldown') return error.upstreamDiagnostic;
  const local = error.rateLimitSource === 'local_cooldown';
  const httpStatus = !local && Number.isInteger(error.diagnostic?.httpStatus) ? error.diagnostic.httpStatus : null;
  return { httpStatus, upstreamRetryAfter: null,
    classification: { probableOrigin: local ? 'studiofy_local_cooldown' : httpStatus !== null ? 'upstream_response_without_safe_details' : 'no_upstream_response',
      confidence: 'high', evidence: [], producerConfirmed: error.rateLimitSource === 'local_cooldown' },
    retryAfterSeconds: error.retryAfterSeconds || null };
}

module.exports = { SAFE_HEADERS, BODY_LIMIT, safeBody, safeHeaders, classifyOrigin, responseDiagnostic, routeDiagnostic };
