const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');
const { installEvolutionOwnership } = require('../../database/evolutionOwnershipInstall');
async function runMigrations({ targetPool = pool,
  mainSchema = process.env.DATABASE_SCHEMA || 'salaoflix',
  legacySchema = process.env.LEGACY_DATABASE_SCHEMA || 'public',
} = {}) {
  for (const value of [mainSchema, legacySchema]) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid Evolution ownership schema configuration.');
  }
  if (mainSchema === legacySchema) throw new Error('Evolution models require distinct source schemas.');
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),0)', [mainSchema]);
    await client.query('CREATE SCHEMA IF NOT EXISTS "' + legacySchema + '"');
    await client.query('SET LOCAL search_path TO "' + legacySchema + '",public');
    const directory = path.join(__dirname, 'migrations');
    for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      await client.query(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
    await installEvolutionOwnership(client, { mainSchema, legacySchema });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { runMigrations };
