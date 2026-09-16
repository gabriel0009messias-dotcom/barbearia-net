// Positive existence only. No provider payload, state, credentials or pairing code.
const entries = new Map();
const TTL_MS = 60000;

function invalidate(key) { entries.delete(key); }
function remember(key) { entries.set(key, { expiresAt: Date.now() + TTL_MS }); }
async function confirm(key, loader, force = false) {
  if (force) invalidate(key);
  const current = entries.get(key);
  if (current?.expiresAt > Date.now()) return true;
  if (current?.pending) return current.pending;
  const entry = {};
  const pending = Promise.resolve().then(loader).then(exists => {
    if (entries.get(key) === entry) {
      if (exists === true) remember(key);
      else invalidate(key);
    }
    return exists === true;
  }, error => {
    if (entries.get(key) === entry) invalidate(key);
    throw error;
  });
  entry.pending = pending;
  entries.set(key, entry);
  return pending;
}
const cleanup = setInterval(() => {
  for (const [key, value] of entries) if (!value.pending && value.expiresAt <= Date.now()) invalidate(key);
}, TTL_MS);
cleanup.unref();
module.exports = { confirm, remember, invalidate };
