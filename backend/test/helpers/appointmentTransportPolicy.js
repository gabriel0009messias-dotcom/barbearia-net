const assert = require('node:assert/strict');

async function setAppointmentTransportPolicy(db, policy) {
  const schema = process.env.DATABASE_SCHEMA;
  assert.match(schema || '', /^test_[a-f0-9]{32}$/, 'Disposable test schema required');
  const value = typeof policy === 'string' ? policy : JSON.stringify(policy);
  await db.runAsync(`INSERT INTO "${schema}".configuracoes(chave,valor)
    VALUES('appointment_reminder_transport_policy_v1',$1)
    ON CONFLICT(chave) DO UPDATE SET valor=EXCLUDED.valor`, [value]);
}
async function enableAppointmentTransport(db) {
  await setAppointmentTransportPolicy(db, { version: 1, enabled: true, scope: 'all', assinatura_ids: [] });
}
module.exports = { setAppointmentTransportPolicy, enableAppointmentTransport };
