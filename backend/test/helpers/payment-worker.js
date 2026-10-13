// Independent process/connection against the same test schema and loopback provider.
const nativeFetch = global.fetch;
global.fetch = (url, options) => {
  const target = new URL(String(url));
  if (target.origin !== 'https://api.mercadopago.com') throw Error('Only the simulated provider is allowed');
  return nativeFetch(process.env.TEST_PAYMENT_PROVIDER + target.pathname + target.search, options);
};
const db = require('../../database');
(async () => {
  try {
    await db.ready;
    const payments = require('../../services/payments/mercadoPago');
    const result = process.argv[2] === 'checkout'
      ? await payments.checkout({ id: Number(process.argv[3]) })
      : await payments.reconcile(process.argv[3], Number(process.argv[4]));
    process.send?.({ ok: true, result });
  } catch (error) { process.send?.({ ok: false, status: error.statusCode, message: error.publicMessage || 'Test worker failed' }); }
  finally { await db.close(); process.disconnect?.(); }
})().catch(() => { process.exitCode = 1; });
