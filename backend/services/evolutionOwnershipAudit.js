const { normalizeInstanceName } = require('./evolutionOwnership');
const canonical = name => String(name).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[A-Z]/g, c => c.toLowerCase());

// A consistent, READ ONLY snapshot. Results contain counts, never provider names,
// tenant identities, telephone numbers, tokens or credentials. No migrations run.
async function auditEvolutionOwnership(pool, {
  mainSchema = process.env.DATABASE_SCHEMA || 'salaoflix',
  legacySchema = process.env.LEGACY_DATABASE_SCHEMA || 'public',
} = {}) {
  for (const value of [mainSchema, legacySchema]) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error('Invalid ownership audit schema.');
  if (mainSchema === legacySchema) throw new Error('Distinct ownership schemas are required.');
  const c = await pool.connect().catch(() => { throw new Error('Read-only Evolution ownership audit failed.'); });
  let broken = false;
  const query = (text, values) => c.query({ text, values, query_timeout: 6000 });
  try {
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL statement_timeout = '5s'");
    await query("SET LOCAL lock_timeout = '1s'");
    const exists = async relation => Boolean((await query('SELECT pg_catalog.to_regclass($1) AS relation', [relation])).rows[0].relation);
    const source = [], present = {};
    for (const [model, schema, table, id, field] of [
      ['principal', mainSchema, 'assinaturas', 'id', 'whatsapp_session'],
      ['alternative', legacySchema, 'whatsapp_sessions', 'salon_id', 'instance_name'],
    ]) {
      present[model] = await exists('"' + schema + '".' + table);
      if (present[model]) {
        const rows = (await query('SELECT ' + id + '::text AS owner_id,' + field + ' AS instance_name FROM "' + schema + '".' + table)).rows;
        for (const row of rows) source.push({ ...row, model, source_schema: schema });
      }
    }
    let invalidNames = 0;
    const byKey = new Map(), expected = new Map();
    for (const row of source) {
      let name;
      try { name = normalizeInstanceName(row.instance_name); if (name && name !== row.instance_name) invalidNames++; }
      catch { invalidNames++; name = row.instance_name; }
      const key = row.instance_name == null ? '' : canonical(row.instance_name);
      if (!key) continue;
      const group = byKey.get(key) || []; group.push(row); byKey.set(key, group);
      expected.set(JSON.stringify([row.model, row.source_schema, row.owner_id]), { ...row, instance_key: key });
    }
    const collisions = { mainMain: 0, alternateAlternate: 0, crossModel: 0 };
    for (const group of byKey.values()) {
      const main = group.filter(x => x.model === 'principal').length, alt = group.length - main;
      if (main > 1) collisions.mainMain++;
      if (alt > 1) collisions.alternateAlternate++;
      if (main && alt) collisions.crossModel++;
    }
    const registryPresent = await exists('"' + mainSchema + '".evolution_instance_owners');
    let missing = 0, mismatched = 0, extra = 0, modelBindings = 0, reservedOperations = 0;
    if (registryPresent) {
      const owners = (await query('SELECT * FROM "' + mainSchema + '".evolution_instance_owners')).rows;
      const seen = new Set();
      for (const row of owners) {
        const identity = JSON.stringify([row.model, row.source_schema, row.owner_id]);
        const origin = expected.get(identity);
        if (seen.has(identity)) mismatched++;
        seen.add(identity);
        if (!origin) extra++;
        else if (origin.instance_name !== row.instance_name || origin.instance_key !== row.instance_key) mismatched++;
        if (row.operation_token) reservedOperations++;
      }
      for (const key of expected.keys()) if (!seen.has(key)) missing++;
      if (await exists('"' + mainSchema + '".evolution_ownership_models')) {
        const bindings = (await query('SELECT model,source_schema FROM "' + mainSchema + '".evolution_ownership_models')).rows;
        for (const [model, schema] of [['principal', mainSchema], ['alternative', legacySchema]]) {
          if (!bindings.some(row => row.model === model && row.source_schema === schema)) modelBindings++;
        }
      } else modelBindings = 2;
    }
    const inconsistent = missing + mismatched + extra + modelBindings;
    const safeToInstall = invalidNames === 0 && Object.values(collisions).every(n => n === 0) && inconsistent === 0;
    await query('COMMIT');
    return Object.freeze({ sourcesPresent: present, associations: expected.size, invalidNames, collisions,
      registryPresent, inconsistent: { missing, mismatched, extra, modelBindings }, reservedOperations,
      safeToInstall, ownershipConsistent: registryPresent && safeToInstall });
  } catch {
    try { await query('ROLLBACK'); } catch { broken = true; }
    throw new Error('Read-only Evolution ownership audit failed.');
  } finally { c.release(broken); }
}
module.exports = { auditEvolutionOwnership };
