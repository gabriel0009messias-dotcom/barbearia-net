const { Pool } = require('pg');
const { connectionConfig } = require('./config');
const { migrate } = require('./migrate');
const pool = new Pool(connectionConfig());
pool.on('error', error => console.error('[database] Conexao PostgreSQL interrompida', { code: error.code || 'CONNECTION_ERROR' }));

function access(query) {
  const api = {
    async runAsync(sql, params = []) {
      if (/^\s*INSERT\b/i.test(sql) && !/\bRETURNING\b/i.test(sql)) sql = sql.replace(/;\s*$/, '') + ' RETURNING *';
      const result = await query(sql, params);
      return { changes: result.rowCount, lastID: result.rows[0]?.id };
    },
    async getAsync(sql, params = []) { return (await query(sql, params)).rows[0]; },
    async allAsync(sql, params = []) { return (await query(sql, params)).rows; },
  };
  api.run = (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    api.runAsync(sql, params).then(result => callback?.call(result, null), error => callback?.(error));
  };
  api.get = (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    api.getAsync(sql, params).then(row => callback?.(null, row), error => callback?.(error));
  };
  api.all = (sql, params, callback) => {
    if (typeof params === 'function') { callback = params; params = []; }
    api.allAsync(sql, params).then(rows => callback?.(null, rows), error => callback?.(error));
  };
  return api;
}
const ready = migrate(pool);
const db = access(async (sql, params) => { await ready; return pool.query(sql, params); });
db.ready = ready;
db.pool = pool;
db.dialect = 'postgres';
db.transaction = async callback => {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Preserve serialized write transactions; external API calls remain outside the lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 1)');
    const result = await callback(access((sql, params) => client.query(sql, params)));
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
db.close = callback => {
  const closing = ready.catch(() => {}).then(() => pool.end());
  if (callback) closing.then(() => callback(null), callback);
  return closing;
};
module.exports = db;
