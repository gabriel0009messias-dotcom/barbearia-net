// Respostas da Evolution podem conter tokens de instancia e credenciais de QR.
const sensitive = /apikey|api.key|authorization|password|senha|secret|token|hash|cookie|credential|pairing|qrcode|^qr$|^key$|^code$|base64|headers/i;

function redactText(value) {
  let text = String(value);
  for (const [key, secret] of Object.entries(process.env)) {
    if (sensitive.test(key) && secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; }
      catch { return '[URL REDACTED]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,"'}]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[ _-]?key|authorization|password|senha|secret|[\w-]*token|hash|pairingCode)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,"'}]+)/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[JWT REDACTED]')
    .replace(/\b\d{10,15}\b/g, '[PHONE REDACTED]');
}

function sanitize(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactText(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    return sanitize({ name: value.name, message: value.message, stack: value.stack,
      errorCode: value.code, statusCode: value.statusCode, upstreamStatus: value.upstreamStatus,
      cause: value.cause, details: value.details, errors: value.errors }, seen);
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, sensitive.test(key) && typeof item !== 'boolean' ? '[REDACTED]' : sanitize(item, seen),
  ]));
}

function logEvolution(event, data = {}, level = 'info') {
  console[level]('[Evolution API]', JSON.stringify(sanitize({ event, ...data })));
}

module.exports = { logEvolution, sanitize };
