const { Pool } = require('pg');

const env = require('../config/env');

const legacySchema = process.env.LEGACY_DATABASE_SCHEMA || 'public';
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(legacySchema)) throw new Error('Invalid legacy database schema.');
const pool = new Pool({
  options: `-c search_path=${legacySchema},public`,
  connectionString: env.databaseUrl,
  ssl: env.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
};
