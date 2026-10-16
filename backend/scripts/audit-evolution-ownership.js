const { Pool } = require('pg');
const { auditEvolutionOwnership } = require('../services/evolutionOwnershipAudit');
// Explicit invocation only. Does not load .env, migrate, start a worker, or import Evolution.
async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only' || !process.env.DATABASE_URL) {
    throw new Error('Explicit --read-only and DATABASE_URL are required.');
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    const result = await auditEvolutionOwnership(pool);
    console.log(JSON.stringify(result));
    if (!result.safeToInstall) process.exitCode = 2;
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(() => { console.error('Read-only ownership audit could not be completed.'); process.exitCode = 1; });
module.exports = { main };
