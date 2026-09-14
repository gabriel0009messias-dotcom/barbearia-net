const { Pool } = require('pg');
const crypto = require('node:crypto');

function testEnvironment() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('Defina TEST_DATABASE_URL para um PostgreSQL exclusivo de testes.');
  const schema = `test_${crypto.randomUUID().replaceAll('-', '')}`;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_SCHEMA = schema;
  return {
    schema,
    async cleanup() {
      if (!/^test_[a-f0-9]{32}$/.test(schema)) throw new Error('Schema de teste invalido.');
      const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    },
  };
}
module.exports = { testEnvironment };
