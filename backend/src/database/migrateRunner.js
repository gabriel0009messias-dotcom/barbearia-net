const { runMigrations } = require('./migrate');
const { pool } = require('./pool');

runMigrations()
  .then(async () => {
    console.log('[migrate] Migrations aplicadas com sucesso.');
    await pool.end();
  })
  .catch(async (error) => {
    console.error('[migrate] Falha ao aplicar migrations', error);
    await pool.end();
    process.exit(1);
  });
