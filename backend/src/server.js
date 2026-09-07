const env = require('./config/env');
const { pool } = require('./database/pool');
const { runMigrations } = require('./database/migrate');
const { createApp } = require('./app');

async function start() {
  await pool.query('SELECT 1');
  await runMigrations();

  const app = createApp();
  const server = app.listen(env.port, () => {
    console.log(`[server] API rodando na porta ${env.port}`);
  });

  server.on('error', (error) => {
    console.error('[server] Falha ao iniciar a API', error);
    process.exitCode = 1;
  });
}

start().catch((error) => {
  console.error('[startup] Falha ao inicializar backend oficial', error);
  process.exit(1);
});
