// Read-only ownership resolution. No Evolution import, transport or ID fallback.
function ownershipError(code) {
  return Object.assign(new Error('Evolution instance ownership could not be validated.'), { code });
}

function normalizeInstanceName(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw ownershipError('INSTANCE_INVALID');
  const name = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) throw ownershipError('INSTANCE_INVALID');
  return name;
}

function createEvolutionOwnershipResolver(db, { schema = process.env.DATABASE_SCHEMA || 'salaoflix' } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw ownershipError('INSTANCE_INVALID_SCHEMA');
  const installed = '"' + schema + '"';
  // The caller must provide an authenticated/internal tenant identity, never a
  // provider name supplied by the customer. This function does not authenticate HTTP.
  async function resolve(assinaturaId, { expectedInstance } = {}) {
    if (!Number.isSafeInteger(assinaturaId) || assinaturaId <= 0) throw ownershipError('INSTANCE_INVALID_TENANT');
    let account;
    try {
      account = await db.getAsync(`SELECT whatsapp_session FROM ${installed}.assinaturas WHERE id=$1`, [assinaturaId]);
    } catch { throw ownershipError('INSTANCE_LOOKUP_FAILED'); }
    if (!account) throw ownershipError('INSTANCE_NOT_CONFIGURED');
    const instanceName = normalizeInstanceName(account.whatsapp_session);
    if (!instanceName) throw ownershipError('INSTANCE_NOT_CONFIGURED');
    // Nonblank legacy names with whitespace are not silently renamed for delivery.
    if (instanceName !== account.whatsapp_session) throw ownershipError('INSTANCE_INVALID');
    if (expectedInstance !== undefined && normalizeInstanceName(expectedInstance) !== instanceName) {
      throw ownershipError('INSTANCE_OWNER_MISMATCH');
    }
    let owners;
    try {
      owners = await db.allAsync(`SELECT model,source_schema,owner_id,instance_name FROM ${installed}.evolution_instance_owners
        WHERE instance_key = $1 COLLATE "C" LIMIT 2`, [instanceName.toLowerCase()]);
    } catch { throw ownershipError('INSTANCE_LOOKUP_FAILED'); }
    if (owners.length !== 1) throw ownershipError('INSTANCE_AMBIGUOUS');
    const owner = owners[0];
    if (owner.model !== 'principal' || owner.source_schema !== schema ||
        owner.owner_id !== String(assinaturaId) || owner.instance_name !== instanceName) {
      throw ownershipError('INSTANCE_OWNER_MISMATCH');
    }
    return Object.freeze({ assinaturaId, instanceName });
  }
  return Object.freeze({ resolve });
}

module.exports = { createEvolutionOwnershipResolver, normalizeInstanceName };
