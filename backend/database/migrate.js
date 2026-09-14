const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function migrate(pool, schema = process.env.DATABASE_SCHEMA || 'salaoflix') {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Schema invalido.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), 0)', [schema]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const directory = path.join(__dirname, 'migrations');
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');
      const previous = (await client.query('SELECT checksum FROM schema_migrations WHERE name = $1', [name])).rows[0];
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Migration ja aplicada foi alterada: ${name}. Crie uma nova migration.`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      console.log(`[database] Migration aplicada: ${name}`);
    }
    await client.query("INSERT INTO configuracoes (chave, valor) VALUES ('suporte_numero', '+55 75 8317-9933'), ('admin_pin', '5090') ON CONFLICT DO NOTHING");
    for (const service of JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'servicos.json'), 'utf8'))) {
      await client.query('INSERT INTO servicos (id, nome, preco) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [service.id, service.nome, service.preco]);
    }
    await client.query("SELECT setval(pg_get_serial_sequence('servicos', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM servicos), 0), 1), EXISTS(SELECT 1 FROM servicos))");
    await client.query('COMMIT');
    console.log(`[database] PostgreSQL conectado; migrations em dia (schema ${schema}).`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
module.exports = { migrate };
