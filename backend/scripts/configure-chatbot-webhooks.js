require('../loadEnv');
const db = require('../database');
const { configurarWebhookInstancia } = require('../evolutionApi');

async function configure() {
  const base = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base) || !process.env.EVOLUTION_WEBHOOK_SECRET) {
    throw new Error('Configure PUBLIC_APP_URL com HTTPS e EVOLUTION_WEBHOOK_SECRET no backend.');
  }
  await db.ready;
  const rows = await db.allAsync("SELECT whatsapp_session AS instance FROM assinaturas WHERE whatsapp_session IS NOT NULL AND whatsapp_session <> '' GROUP BY whatsapp_session HAVING COUNT(*) = 1");
  let failed = 0;
  for (const row of rows) {
    try { await configurarWebhookInstancia(row.instance, `${base}/api/webhook/evolution`); }
    catch { failed++; }
  }
  console.info(`Webhooks configurados: ${rows.length - failed}; falhas: ${failed}. Nenhuma sessão foi desconectada.`);
  if (failed) process.exitCode = 1;
}
configure().catch(() => {
  console.error('Falha ao configurar webhooks. Verifique PUBLIC_APP_URL, EVOLUTION_WEBHOOK_SECRET e o acesso à Evolution API.');
  process.exitCode = 1;
}).finally(() => db.close());
