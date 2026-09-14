require('../loadEnv');
const { Pool } = require('pg');
const { connectionConfig } = require('../database/config');
const { migrate } = require('../database/migrate');

async function main() {
  const pool = new Pool(connectionConfig());
  try { await migrate(pool); } finally { await pool.end(); }
}
main().catch(error => { console.error('[database] Falha nas migrations', { code: error.code, message: error.message }); process.exitCode = 1; });
