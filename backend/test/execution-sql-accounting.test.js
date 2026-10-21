const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createExecutionScope } = require('../services/executionScope');
const { createSqlAccounting } = require('../services/executionSql');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(raw) {
  const scope = createExecutionScope({ certifiable: true });
  scope.setExecutor({ executorId: randomUUID(), bootId: randomUUID() });
  const accounting = createSqlAccounting(scope);
  return { scope, accounting, pool: accounting.wrapPool(raw) };
}

test('real PostgreSQL accounting, deadlines, transactions and ambiguous COMMIT', async t => {
  assert.ok(process.env.TEST_DATABASE_URL, 'exclusive local test database required');
  const raw = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  t.after(() => raw.end());
  await t.test('query_timeout returns before pg_sleep completes and release retains the borrow', async () => {
    const { scope, pool } = fixture(raw), client = await pool.connect();
    await assert.rejects(client.query({ text: 'SELECT pg_sleep(0.15)', query_timeout: 10 }), { code: 'SQL_CALLER_TIMEOUT' });
    client.release();
    assert.equal((await scope.drain({ timeoutMs: 2 })).drained, false);
    assert.ok(scope.snapshot().obligations.includes('sql.query'));
    await scope.drain(); assert.ok(scope.sealClosedScope());
    await assert.rejects(client.query('SELECT 1'));
  });
  await t.test('pool.query, acquisition callback and query callback remain counted through async callbacks', async () => {
    const { scope, pool } = fixture(raw), callback = deferred(), entered = deferred();
    pool.query('SELECT 42 AS answer', async (error, result) => {
      assert.ifError(error); assert.equal(result.rows[0].answer, 42); entered.resolve(); await callback.promise;
    });
    await entered.promise;
    assert.equal((await scope.drain({ timeoutMs: 1 })).drained, false);
    callback.resolve(); await scope.drain(); scope.sealClosedScope();
    await assert.rejects(pool.query('SELECT 1'));
    const next = fixture(raw), done = deferred();
    next.pool.connect((error, client, release) => {
      assert.ifError(error); client.query('SELECT 1', err => { assert.ifError(err); release(); done.resolve(); });
    });
    await done.promise; await next.scope.drain(); next.scope.sealClosedScope();
  });
  await t.test('BEGIN and real transaction stay live until acknowledged ROLLBACK', async () => {
    const { scope, accounting, pool } = fixture(raw), entered = deferred(), release = deferred();
    const work = accounting.run('booking.transaction', async () => {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query('SELECT 1'); entered.resolve(); await release.promise; await client.query('ROLLBACK'); }
      finally { client.release(); }
    });
    await entered.promise; assert.equal((await scope.drain({ timeoutMs: 1 })).drained, false);
    assert.ok(scope.snapshot().obligations.includes('sql.transaction'));
    release.resolve(); await work; await scope.drain(); scope.sealClosedScope();
  });
  await t.test('pool deadline, SQL server error and rollback-to-savepoint preserve the real transaction boundary', async () => {
    const { scope, pool } = fixture(raw);
    await assert.rejects(pool.query({ text: 'SELECT pg_sleep(0.12)', query_timeout: 5 }), { code: 'SQL_CALLER_TIMEOUT' });
    assert.ok(scope.snapshot().obligations.includes('sql.query'));
    await new Promise(resolve => setTimeout(resolve, 160));
    const client = await pool.connect();
    await client.query('START TRANSACTION'); await client.query('SAVEPOINT cooperative');
    await assert.rejects(client.query('SELECT invalid_cooperative_column'), { code: '42703' });
    await client.query('ROLLBACK TO SAVEPOINT cooperative');
    assert.ok(scope.snapshot().obligations.includes('sql.transaction'));
    await client.query('COMMIT'); client.release();
    await scope.drain(); assert.ok(scope.sealClosedScope());
  });
  await t.test('real COMMIT with lost acknowledgement is never repaired by subsequent ROLLBACK', async () => {
    const borrowed = await raw.connect();
    const query = borrowed.query.bind(borrowed);
    const fault = new Proxy(borrowed, { get(target, property) {
      if (property === 'query') return (config, callback) => query(config, (error, result) => {
        if (!error && config.text === 'COMMIT') callback(Object.assign(Error('Acknowledgement lost after real COMMIT'), { code: '08006' }));
        else callback(error, result);
      });
      const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    const { scope, pool } = fixture({ connect: async () => fault });
    const client = await pool.connect();
    await client.query('BEGIN'); await client.query('CREATE TEMP TABLE cooperative_commit_fact(value integer) ON COMMIT DROP');
    await assert.rejects(client.query('COMMIT'), { code: '08006' });
    await client.query('ROLLBACK'); client.release();
    assert.equal((await scope.drain({ timeoutMs: 1 })).drained, false);
    assert.ok(scope.snapshot().certificationBlocked.includes('CERTIFICATION_BLOCKED_UNKNOWN_SQL'));
    assert.throws(scope.sealClosedScope);
  });
  await t.test('real connection failure blocks certification; no proof fallback', async () => {
    const down = new Pool({ host: '127.0.0.1', port: 1, user: 'synthetic', database: 'postgres', connectionTimeoutMillis: 100 });
    try {
      const { scope, pool } = fixture(down); await assert.rejects(pool.connect());
      await scope.drain(); assert.throws(scope.sealClosedScope);
      assert.ok(scope.snapshot().certificationBlocked.includes('CERTIFICATION_BLOCKED_UNKNOWN_SQL'));
    } finally { await down.end(); }
  });
});
