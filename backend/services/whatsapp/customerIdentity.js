const { normalizeBrazilianDestination } = require('./phone');
function customerName(value) {
  if (typeof value !== 'string' || /[<>\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return null;
  const name = value.normalize('NFC').trim().replace(/\s+/g, ' ');
  return name.length >= 2 && name.length <= 100 && /^[\p{L}\p{M} .’'\-]+$/u.test(name) && (name.match(/\p{L}/gu) || []).length >= 2 ? name : null;
}
async function identifyCustomer(db, tenant, phone) {
  if (!Number.isSafeInteger(tenant) || tenant <= 0 || normalizeBrazilianDestination(phone) !== phone) throw Error('Invalid customer identity');
  await db.runAsync(`INSERT INTO clientes(assinatura_id,telefone,nome) VALUES($1,$2,'')
    ON CONFLICT(assinatura_id,telefone) WHERE assinatura_id IS NOT NULL DO NOTHING`, [tenant, phone]);
  return db.getAsync('SELECT id,nome,telefone FROM clientes WHERE assinatura_id=$1 AND telefone=$2 FOR UPDATE', [tenant, phone]);
}
async function saveCustomerName(db, tenant, phone, value) {
  const name = customerName(value);
  if (!name) return null;
  const customer = await identifyCustomer(db, tenant, phone);
  // Registration is separate from beneficiary/appointment names.
  if (!customerName(customer.nome)) await db.runAsync('UPDATE clientes SET nome=$1,updated_at=clock_timestamp() WHERE id=$2 AND assinatura_id=$3', [name, customer.id, tenant]);
  return customerName(customer.nome) || name;
}
module.exports = { customerName, identifyCustomer, saveCustomerName };
