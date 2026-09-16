// Coordination is local to this Node process. Pairing results are reusable for 15 seconds; expired entries are pruned.
const queues = new Map();
const cooldowns = new Map();
const connections = new Map();

function retryAfterMs(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  if (/^\d+$/.test(value.trim())) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : 0;
  }
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())) return 0;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function rateLimitError(state) {
  const retryAfterSeconds = Math.max(1, Math.ceil((state.until - Date.now()) / 1000));
  return Object.assign(new Error(`O WhatsApp recebeu muitas solicitacoes. Aguarde ${retryAfterSeconds} segundos para tentar novamente.`), {
    code: 'EVOLUTION_RATE_LIMIT', statusCode: 429, upstreamStatus: 429,
    retryAfterSeconds, retryAt: state.until,
  });
}

function checkCooldown(key) {
  const state = cooldowns.get(key);
  if (state?.until > Date.now()) throw rateLimitError(state);
}

function recordRateLimit(key, header) {
  const previous = cooldowns.get(key);
  const failures = previous && Date.now() - previous.until < 600000 ? previous.failures + 1 : 1;
  const delay = Math.max(retryAfterMs(header), Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)));
  const state = { failures, until: Date.now() + delay };
  cooldowns.set(key, state);
  return rateLimitError(state);
}

function serialize(key, task) {
  checkCooldown(key);
  const previous = queues.get(key) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => { checkCooldown(key); return task(); });
  queues.set(key, job);
  return job.finally(() => { if (queues.get(key) === job) queues.delete(key); });
}

function connectOnce(key, mode, task) {
  checkCooldown(key);
  const current = connections.get(key);
  if (current && (current.pending || current.until > Date.now())) {
    if (current.mode !== mode) throw Object.assign(new Error('Existe uma tentativa de conexao em andamento. Aguarde antes de trocar o metodo ou numero.'), { statusCode: 409, code: 'WHATSAPP_BUSY' });
    return current.promise;
  }
  const entry = { mode, pending: true, until: 0 };
  entry.promise = Promise.resolve().then(task).then(result => {
    entry.pending = false;
    entry.until = Date.now() + 15000;
    return result;
  }, error => { connections.delete(key); throw error; });
  connections.set(key, entry);
  return entry.promise;
}

function invalidateConnection(key) { connections.delete(key); }

// Bound retention without timers that keep the process alive.
const cleanup = setInterval(() => {
  for (const [key, state] of cooldowns) if (Date.now() - state.until > 600000) cooldowns.delete(key);
  for (const [key, state] of connections) if (!state.pending && state.until <= Date.now()) connections.delete(key);
}, 60000);
cleanup.unref();

module.exports = { retryAfterMs, checkCooldown, recordRateLimit, serialize, connectOnce, invalidateConnection };
