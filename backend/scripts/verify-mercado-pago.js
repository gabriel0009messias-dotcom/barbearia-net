require('../loadEnv');
const db = require('../database');
const payments = require('../services/payments/mercadoPago');

async function main() {
  const [paymentId, subscriptionId] = process.argv.slice(2);
  if (!/^\d+$/.test(paymentId || '') || !/^[1-9]\d*$/.test(subscriptionId || '')) {
    throw new Error('Uso: npm run payments:verify -- ID_PAGAMENTO ID_ASSINATURA');
  }
  await db.ready;
  const result = await payments.reconcile(paymentId, Number(subscriptionId));
  console.log(JSON.stringify(result));
  const subscription = await db.getAsync(`SELECT id, status, status_assinatura, gateway_provider, gateway_status,
    payment_id, ultimo_pagamento, proximo_vencimento, bloqueado FROM assinaturas WHERE id = $1`, [subscriptionId]);
  console.table(subscription);
}

main().catch(error => {
  console.error(error.publicMessage || error.message);
  process.exitCode = 1;
}).finally(async () => {
  await db.ready.catch(() => {});
  db.close();
});
