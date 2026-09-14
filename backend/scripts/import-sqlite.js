// SQLite is read-only here. The application itself uses PostgreSQL exclusively.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const { Pool } = require('pg');
const { connectionConfig } = require('../database/config');
const { migrate } = require('../database/migrate');

const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';

async function readSnapshot(filename) {
  if (!fs.existsSync(filename)) throw new Error('Arquivo SQLite nao encontrado.');
  const connection = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
  });
  const all = (sql) => new Promise((resolve, reject) => connection.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
  try {
    await all('BEGIN');
    const names = await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const tables = [];
    for (const { name } of names) {
      tables.push({ name, columns: (await all(`PRAGMA table_info(${identifier(name)})`)).map(c => c.name), rows: await all(`SELECT * FROM ${identifier(name)} ORDER BY rowid`) });
    }
    await all('COMMIT');
    return tables;
  } finally { await new Promise(resolve => connection.close(resolve)); }
}

async function importSqlite(filename, options = {}) {
  const tables = await readSnapshot(path.resolve(filename));
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex');
  const pool = new Pool(connectionConfig());
  try {
    await migrate(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 1)');
      const previous = await client.query('SELECT counts FROM sqlite_imports WHERE source_hash = $1', [sourceHash]);
      if (previous.rowCount) {
        await client.query('COMMIT');
        return { alreadyImported: true, counts: previous.rows[0].counts };
      }
      const metadata = (await client.query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()')).rows;
      const seedServices = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'servicos.json'), 'utf8'));
      // Never merge into an operating system: conflicting IDs could connect the wrong customer/payment.
      for (const name of [...new Set(metadata.map(c => c.table_name))].filter(name => !['schema_migrations', 'sqlite_imports'].includes(name))) {
        const rows = (await client.query(`SELECT * FROM ${identifier(name)}`)).rows;
        const onlySeeds = name === 'configuracoes'
          ? rows.every(row => ({ suporte_numero: '+55 75 8317-9933', admin_pin: '5090' })[row.chave] === row.valor)
          : name === 'servicos' && rows.every(row => seedServices.some(seed => seed.id === row.id && seed.nome === row.nome && seed.preco === row.preco));
        if (rows.length && !onlySeeds) throw new Error(`Destino possui dados em ${name}. Use um banco/schema novo para a importacao.`);
      }
      for (const table of tables) {
        const known = metadata.filter(c => c.table_name === table.name).map(c => c.column_name);
        if (!known.length || table.columns.some(column => !known.includes(column))) {
          throw new Error(`Schema nao contempla todos os campos de ${table.name}. Crie uma migration antes de importar.`);
        }
      }
      const counts = {};
      for (const table of tables) {
        const columns = table.columns.map(identifier).join(', ');
        const params = table.columns.map((_, i) => `$${i + 1}`).join(', ');
        const key = table.name === 'configuracoes' ? 'chave' : table.name === 'servicos' ? 'id' : null;
        const conflict = key ? ` ON CONFLICT (${identifier(key)}) DO UPDATE SET ${table.columns.filter(c => c !== key).map(c => `${identifier(c)} = EXCLUDED.${identifier(c)}`).join(', ')}` : '';
        for (const row of table.rows) {
          await client.query(`INSERT INTO ${identifier(table.name)} (${columns}) VALUES (${params})${conflict}`, table.columns.map(c => row[c]));
        }
        // Verify every imported value, not only the number of inserted rows.
        const imported = (await client.query(`SELECT ${columns} FROM ${identifier(table.name)}`)).rows;
        const canonical = row => JSON.stringify(table.columns.map(c => row[c]));
        const values = new Set(imported.map(canonical));
        if (table.rows.some(row => !values.has(canonical(row)))) throw new Error(`Falha na verificacao de dados de ${table.name}.`);
        counts[table.name] = table.rows.length;
      }
      const identities = (await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'")).rows;
      for (const { table_name: table, column_name: column } of identities) {
        await client.query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE((SELECT MAX(${identifier(column)}) FROM ${identifier(table)}), 0), 1), EXISTS(SELECT 1 FROM ${identifier(table)}))`, [table, column]);
      }
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      if (options.checkOnly) {
        await client.query('ROLLBACK');
        return { checkOnly: true, counts };
      }
      await client.query('INSERT INTO sqlite_imports (source_hash, counts) VALUES ($1, $2)', [sourceHash, JSON.stringify(counts)]);
      await client.query('COMMIT');
      return { imported: true, counts };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } finally { await pool.end(); }
}

if (require.main === module) {
  require('../loadEnv');
  const args = process.argv.slice(2);
  const filename = args.find(arg => !arg.startsWith('--'));
  if (!filename) { console.error('Uso: npm run db:import-sqlite -- CAMINHO_SQLITE [--check]'); process.exitCode = 1; }
  else importSqlite(filename, { checkOnly: args.includes('--check') }).then(result => console.log(JSON.stringify(result))).catch(error => {
    // Do not print SQL parameters or customer information on constraint errors.
    console.error('[import] Importacao nao concluida; dados do destino revertidos.', error.code ? { code: error.code, table: error.table, constraint: error.constraint } : error.message);
    process.exitCode = 1;
  });
}
module.exports = { importSqlite };
