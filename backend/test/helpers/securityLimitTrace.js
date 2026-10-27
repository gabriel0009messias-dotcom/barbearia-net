// Test-only adapter. Extend RETURNING metadata, never the counter mutation,
// clock, lock, policy, identity, secret or decision performed by the service.
const { createHash, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createSecurityLimits, POLICIES } = require('../../services/securityLimits');
const fingerprint = value => createHash('sha256').update(String(value)).digest('hex');
function windowRelation(a, b) {
  if (!a?.windowId || !b?.windowId || a.namespaceFingerprint !== b.namespaceFingerprint || a.keyFingerprint !== b.keyFingerprint)
    return 'UNKNOWN';
  return a.windowId === b.windowId ? 'SAME_WINDOW' : 'DIFFERENT_WINDOW';
}
function createTracedSecurityLimits(db, { namespace }) {
  const context = new AsyncLocalStorage(), records = [], instanceFingerprint = randomUUID().replaceAll('-', '');
  const namespaceFingerprint = fingerprint(namespace); let secretFingerprint = null;
  const wrapped = { ...db,
    async getAsync(sql, params) {
      const row = await db.getAsync(sql, params);
      if (sql.includes("VALUES ('security_limit_key_v1',$1)") && typeof row?.valor === 'string') secretFingerprint = fingerprint(row.valor);
      return row;
    },
    transaction(fn, options) {
      return db.transaction(store => fn({ ...store, async getAsync(sql, params) {
        if (!sql.includes('WITH moment AS (') || !sql.includes('INSERT INTO public_request_limits') || !sql.includes('RETURNING hits,ceil'))
          return store.getAsync(sql, params);
        // PostgreSQL 18 OLD exposes the pre-update row even at the saturated
        // limit+1 cap. The other fields are the exact row/window just written.
        const row = await store.getAsync(sql + ',old.hits AS __h5_before,window_start::text AS __h5_window,' +
          'expires_at AS __h5_end,clock_timestamp() AS __h5_at', params);
        if (!row) return row;
        const { __h5_before, __h5_window, __h5_end, __h5_at, ...original } = row;
        const request = context.getStore();
        if (request) request.counter = {
          keyFingerprint: fingerprint(params[0]), windowId: /^\d{1,16}$/.test(String(__h5_window)) ? String(__h5_window) : null,
          timestamp: __h5_at instanceof Date && Number.isFinite(__h5_at.getTime()) ? __h5_at.toISOString() : null,
          windowEnd: __h5_end instanceof Date && Number.isFinite(__h5_end.getTime()) ? __h5_end.toISOString() : null,
          counterBefore: __h5_before === null ? 0 : Number.isSafeInteger(__h5_before) ? __h5_before : null,
          beforeState: __h5_before === null ? 'ABSENT' : Number.isSafeInteger(__h5_before) ? 'OBSERVED' : 'UNAVAILABLE',
          counterAfter: Number.isSafeInteger(original.hits) ? original.hits : null,
        };
        return original;
      } }), options);
    },
  };
  const limiter = createSecurityLimits(wrapped);
  return { budgetKey: limiter.budgetKey,
    async check(res, scope, identity) {
      const request = {}; let admitted;
      return context.run(request, async () => {
        try { admitted = await limiter.check(res, scope, identity); return admitted; }
        finally {
          const limit = Object.hasOwn(POLICIES, scope) ? POLICIES[scope].limit : null;
          records.push({ ...request.counter, timestamp: request.counter?.timestamp || new Date().toISOString(),
            namespaceFingerprint, secretFingerprint, instanceFingerprint, processId: process.pid,
            limit, admitted: typeof admitted === 'boolean' ? admitted : null,
            decision: res.statusCode === 429 ? 'LIMIT' : res.statusCode === 200 && admitted === true ? 'ALLOW' : 'UNAVAILABLE',
            httpResult: [200,429,503].includes(res.statusCode) ? res.statusCode : null });
          if (records.length > 256) records.shift();
        }
      });
    },
    decisionTrace: () => records.map(row => ({ ...row })),
  };
}
module.exports = { createTracedSecurityLimits, fingerprint, windowRelation };
