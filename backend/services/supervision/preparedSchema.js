const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validatePermissions } = require('./sql031Permissions');
async function verifyPreparedSchema(pool) {
  // Read-only boundary, never invokes migrate() or writes the 031 foundation.
  const result = await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
  const directory = path.join(__dirname,'../../database/migrations');
  const names = fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  if (result.rows.length !== names.length) throw Error('Prepared schema version mismatch.');
  for (const [i,name] of names.entries()) {
    const hash = createHash('sha256').update(fs.readFileSync(path.join(directory,name))).digest('hex');
    if (result.rows[i].name !== name || result.rows[i].checksum !== hash) throw Error('Prepared schema checksum mismatch.');
  }
  const client = await pool.connect();
  try {
    if (!['localhost', '127.0.0.1', '::1'].includes(client.connectionParameters?.host)) throw Error('Local executor required.');
    await validatePermissions(client, { profile: 'EXECUTOR' });
  } finally { client.release(); }
}
module.exports = { verifyPreparedSchema };
