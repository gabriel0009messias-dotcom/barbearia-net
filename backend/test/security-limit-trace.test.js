const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracedSecurityLimits, fingerprint, windowRelation } = require('./helpers/securityLimitTrace');
const response = () => ({ statusCode: 200, set() { return this; }, status(n) { this.statusCode = n; return this; }, json() { return this; } });
function fakeStore(rows, secret) {
  const queries = []; const store = {
    getAsync: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('security_limit_key_v1')) return { valor: secret };
      return rows.shift();
    }, runAsync: async () => {},
  };
  return { queries, getAsync: store.getAsync, transaction: (fn, options) => { assert.equal(options, undefined); return fn(store); } };
}
const row = (window, before, hits) => ({ hits, retry: 10, __h5_before: before, __h5_window: String(window),
  __h5_end: new Date(Number(window) + 300000), __h5_at: new Date(Number(window) + 299999) });

test('H5 counter diagnostics distinguish actual stored SAME/DIFFERENT WINDOW without changing any clock', async () => {
  const afterBoundary = { ...row(600000, null, 1), __h5_at: new Date(600001) };
  const db = fakeStore([row(300000, 20, 21), row(300000, 21, 21), afterBoundary], 'a'.repeat(64));
  const limiter = createTracedSecurityLimits(db, { namespace: 'test_namespace' });
  const statuses = [];
  for (let i = 0; i < 3; i++) { const res = response(); await limiter.check(res, 'adminLogin', 'synthetic-person'); statuses.push(res.statusCode); }
  assert.deepEqual(statuses, [429, 429, 200]); const trace = limiter.decisionTrace();
  assert.equal(windowRelation(trace[0], trace[1]), 'SAME_WINDOW'); assert.equal(windowRelation(trace[1], trace[2]), 'DIFFERENT_WINDOW');
  assert.equal(trace[0].timestamp, new Date(599999).toISOString()); assert.equal(trace[2].timestamp, new Date(600001).toISOString());
  assert.deepEqual(trace.map(r => r.counterBefore), [20, 21, 0]); assert.deepEqual(trace.map(r => r.counterAfter), [21, 21, 1]);
  assert.equal(trace[2].beforeState, 'ABSENT'); assert.equal(trace[0].limit, 20); assert.equal(trace[0].decision, 'LIMIT');
  assert.equal(trace[2].decision, 'ALLOW'); assert.equal(trace[0].httpResult, 429); assert.ok(trace.every(r => r.timestamp && r.windowEnd));
  for (const q of db.queries.filter(q => q.sql.includes('WITH moment AS ('))) {
    assert.ok(q.sql.includes('old.hits AS __h5_before')); assert.ok(q.sql.includes('window_start::text AS __h5_window'));
    assert.ok(q.sql.includes('SET hits=LEAST(public_request_limits.hits::bigint+1,$3::bigint+1)::integer'));
    assert.equal(q.params[1], 300000); assert.equal(q.params[2], 20);
  }
});

test('H5 counter fingerprints are stable, distinct and exclude raw credentials, keys and identity', async () => {
  const secret = 'synthetic-secret-password-' + 'a'.repeat(64), namespace = 'postgresql://user:synthetic-connection-password@db.test/private';
  // Service accepts only a 64-hex secret. Use that valid value and separately
  // prove the fingerprint function never returns its arbitrary sensitive input.
  assert.notEqual(fingerprint(secret), secret); assert.equal(fingerprint(secret), fingerprint(secret));
  assert.notEqual(fingerprint(secret), fingerprint(secret + 'different'));
  const rawSecret = 'a'.repeat(64), identity = 'synthetic-customer-private';
  const a = createTracedSecurityLimits(fakeStore([row(300000, 0, 1)], rawSecret), { namespace });
  const b = createTracedSecurityLimits(fakeStore([row(300000, 0, 1)], rawSecret), { namespace });
  await a.check(response(), 'adminLogin', identity); await b.check(response(), 'adminLogin', identity);
  const ar = a.decisionTrace()[0], br = b.decisionTrace()[0];
  assert.equal(ar.keyFingerprint, br.keyFingerprint); assert.equal(ar.secretFingerprint, br.secretFingerprint);
  assert.equal(ar.namespaceFingerprint, br.namespaceFingerprint); assert.notEqual(ar.instanceFingerprint, br.instanceFingerprint);
  const output = JSON.stringify([ar, br]);
  for (const value of [rawSecret, identity, namespace, 'synthetic-connection-password', 'postgresql://']) assert.equal(output.includes(value), false);
  const c = createTracedSecurityLimits(fakeStore([row(300000, 0, 1)], 'b'.repeat(64)), { namespace: namespace + 'different' });
  await c.check(response(), 'adminLogin', identity); const cr = c.decisionTrace()[0];
  assert.notEqual(cr.secretFingerprint, ar.secretFingerprint); assert.notEqual(cr.namespaceFingerprint, ar.namespaceFingerprint);
  assert.notEqual(cr.keyFingerprint, ar.keyFingerprint); assert.equal(windowRelation(ar, cr), 'UNKNOWN');
});

test('H5 counter preserves fail-closed results and keeps its diagnostic buffer bounded', async () => {
  const rows = Array.from({ length: 270 }, () => row(300000, 0, 1));
  const limiter = createTracedSecurityLimits(fakeStore(rows, 'a'.repeat(64)), { namespace: 'unit' });
  for (let i = 0; i < 270; i++) await limiter.check(response(), 'adminLogin', 'unit');
  assert.equal(limiter.decisionTrace().length, 256);
  const failure = createTracedSecurityLimits({ getAsync: async () => { throw Error('synthetic-secret'); } }, { namespace: 'unit' });
  const res = response(); assert.equal(await failure.check(res, 'adminLogin', 'unit'), false); assert.equal(res.statusCode, 503);
  assert.equal(failure.decisionTrace()[0].decision, 'UNAVAILABLE'); assert.equal(JSON.stringify(failure.decisionTrace()).includes('synthetic-secret'), false);
});
