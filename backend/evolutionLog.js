// Respostas da Evolution podem conter tokens de instancia e credenciais de QR.
const sensitive = /apikey|api.key|authorization|password|senha|secret|token|hash|cookie|credential|pairing|qrcode|^qr$|^key$|^code$|base64|headers|database.url|private.key/i;

function redactText(value, maskPhone = true) {
  let text = String(value);
  for (const [key, secret] of Object.entries(process.env)) {
    if (sensitive.test(key) && secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  text = text
    .replace(/\b(?:postgres(?:ql)?|redis|rediss|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi, '[CONNECTION STRING REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
      catch { return '[URL REDACTED]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[ _-]?key|authorization|password|senha|secret|[\w-]*token|hash|pairingCode)\s*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,"'}]+)/gi,
      (_, prefix, value) => prefix + (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : '[REDACTED]'))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT REDACTED]');
  return maskPhone ? text.replace(/\b\d{10,15}\b/g, '[PHONE REDACTED]') : text;
}

// Sanitize before truncating: a cut inside a credential must never expose its prefix.
function redactDiagnosticText(raw) {
  return redactText(raw)
      .replace(/<(?:input|meta)\b[^>]*(?:key|authorization|token|password|senha|secret|cookie|pairing|credential)[^>]*>/gi, '[SENSITIVE HTML REDACTED]')
      .replace(/((?:set-cookie|cookie|authorization)\s*["']?\s*[:=]\s*)[^\r\n<]*/gi, '$1[REDACTED]')
      .replace(/((?:[\w-]*(?:token|secret|password|credential)|api[ _-]?key|senha|pairing[ _-]?(?:code)?|qr[ _-]?code|database[ _-]?url|code)\s*["']?\s*(?:[:=]|<\/[^>]+>\s*<[^>]+>)\s*)(?:"[^"]*"|'[^']*'|[^\s<,;}]+)/gi, '$1[REDACTED]');
}

function sanitizeUpstreamBody(raw) {
  let safe;
  try {
    const parsed = JSON.parse(raw, (_, value) => typeof value === 'string' ? redactDiagnosticText(value) : value);
    safe = JSON.stringify(sanitize(parsed));
  } catch { safe = redactDiagnosticText(raw); }
  return { body: safe.slice(0, 1000), bodyTruncated: safe.length > 1000 };
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack,
      errorCode: value.code, statusCode: value.statusCode, upstreamStatus: value.upstreamStatus, rateLimitSource: value.rateLimitSource, retryAfterSeconds: value.retryAfterSeconds, retryAt: value.retryAt,
      cause: value.cause, details: value.details, errors: value.errors }, seen);
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitive.test(key) && typeof item !== 'boolean' ? '[REDACTED]' :
      /^(?:x-)?ratelimit-(?:limit|remaining|reset)$/.test(key) && typeof item === 'string' && /^\d+$/.test(item)
        ? redactText(item, false) : sanitize(item, seen),
  ]));
}

function logEvolution(event, data = {}, level = 'info') {
  const safe = sanitize({ event, ...data });
  if (event === 'evolution_upstream_429' && typeof safe.body === 'string') {
    safe.bodyTruncated ||= safe.body.length > 1000;
    safe.body = safe.body.slice(0, 1000);
  }
  console[level]('[Evolution API]', JSON.stringify(safe));
}

module.exports = { logEvolution, sanitize, sanitizeUpstreamBody };
