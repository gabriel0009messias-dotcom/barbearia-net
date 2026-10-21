const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const identityKey = Symbol.for('studiofy.executionLifecycle.process.v1');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const metadata = name => {
  const value = process.env[name];
  return typeof value === 'string' && /^[A-Za-z0-9_.:/ -]{1,200}$/.test(value) ? value : null;
};

// One identity per Node process, including across module reloads. A restarted
// process gets fresh UUIDs even when its PID or deployment commit is reused.
function processIdentity() {
  if (!globalThis[identityKey]) {
    Object.defineProperty(globalThis, identityKey, { value: Object.freeze({
      executorId: randomUUID(), bootId: randomUUID(), processId: process.pid,
      startedAt: new Date(performance.timeOrigin).toISOString(), serviceId: metadata('RENDER_SERVICE_ID'),
      deploymentId: metadata('RENDER_DEPLOY_ID'), instanceId: metadata('RENDER_INSTANCE_ID'),
      revision: metadata('RENDER_GIT_COMMIT'),
    }) });
  }
  return globalThis[identityKey];
}

function deliveryIdentity(value) {
  if (value === undefined) return null;
  if (!value || !['whatsapp_messages', 'appointment_reminders'].includes(value.kind) ||
      !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.claimToken !== 'string' || !uuid.test(value.claimToken)) {
    throw Object.assign(new Error('Invalid execution delivery identity.'), { code: 'INSTANCE_DELIVERY_CLAIM_MISMATCH' });
  }
  return Object.freeze({ kind: value.kind, id: value.id, claimToken: value.claimToken });
}

// SQL only, on the SAME transaction/connection which acquired the reservation.
// Registration failure rolls back both reservation and delivery binding.
async function registerExecution(client, schema, owner, operationToken, delivery) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid execution schema.');
  const s = '"' + schema + '"', executor = processIdentity(), executionId = randomUUID();
  await client.query('INSERT INTO ' + s + '.evolution_executors' +
    '(executor_id,boot_id,process_id,started_at,service_id,deployment_id,instance_id,revision)' +
    ' VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(executor_id) DO NOTHING',
    [executor.executorId,executor.bootId,executor.processId,executor.startedAt,executor.serviceId,executor.deploymentId,executor.instanceId,executor.revision]);
  const inserted = await client.query('INSERT INTO ' + s + '.evolution_operation_executions' +
    '(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token)' +
    ' SELECT $1,e.executor_id,$3,$4,$5,$6,$7,$8 FROM ' + s + '.evolution_executors e' +
    ' WHERE e.executor_id=$2 AND e.boot_id=$9 AND e.process_id=$10 AND e.started_at=$11' +
    ' AND e.service_id IS NOT DISTINCT FROM $12 AND e.deployment_id IS NOT DISTINCT FROM $13' +
    ' AND e.instance_id IS NOT DISTINCT FROM $14 AND e.revision IS NOT DISTINCT FROM $15 RETURNING execution_id',
    [executionId,executor.executorId,operationToken,owner.assinaturaId,owner.instanceName,
      delivery?.kind || 'instance_operation',delivery?.id || null,delivery?.claimToken || null,
      executor.bootId,executor.processId,executor.startedAt,executor.serviceId,executor.deploymentId,executor.instanceId,executor.revision]);
  if (inserted.rowCount !== 1) throw Error('Executor identity mismatch.');
  return Object.freeze({ executionId, executorId: executor.executorId, bootId: executor.bootId });
}

// Called only inside an ownership transaction (source/owner locked first).
// The caller commits an expired -> UNKNOWN transition before reporting denial.
async function checkAuthorization(client, schema, context, delivery, { renew = false, revoke = false } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid execution schema.');
  delivery = deliveryIdentity(delivery === null ? undefined : delivery);
  const s = '"' + schema + '"', identity = processIdentity();
  if (context.executorId !== identity.executorId || context.bootId !== identity.bootId) return false;
  const found = await client.query('SELECT a.state,a.lease_until>clock_timestamp() AS valid FROM ' + s + '.evolution_execution_authorizations a' +
    ' JOIN ' + s + '.evolution_operation_executions e USING(execution_id)' +
    ' JOIN ' + s + '.evolution_executors x USING(executor_id)' +
    ' JOIN ' + s + '.evolution_instance_owners o ON o.operation_token=e.operation_token' +
    ' WHERE e.execution_id=$1 AND e.executor_id=$2 AND x.boot_id=$3 AND e.operation_token=$4' +
    ' AND e.assinatura_id=$5 AND e.instance_name=$6 AND e.operation_kind=$7' +
    ' AND e.delivery_id IS NOT DISTINCT FROM $8::bigint AND e.claim_token IS NOT DISTINCT FROM $9::uuid' +
    ' AND o.model=\'principal\' AND o.source_schema=$10 AND o.owner_id=$11 AND o.instance_name=$6 FOR UPDATE OF a',
    [context.executionId,context.executorId,context.bootId,context.operationToken,context.assinaturaId,context.instanceName,
      delivery?.kind || 'instance_operation',delivery?.id || null,delivery?.claimToken || null,schema,String(context.assinaturaId)]);
  const row = found.rows[0];
  if (!row || row.state !== 'ACTIVE') return false;
  if (revoke || !row.valid) {
    await client.query('UPDATE ' + s + ".evolution_execution_authorizations SET state='UNKNOWN' WHERE execution_id=$1 AND state='ACTIVE'", [context.executionId]);
    return false;
  }
  if (delivery) {
    const match = await client.query('SELECT id FROM ' + s + '.' + delivery.kind +
      ' WHERE id=$1 AND assinatura_id=$2 AND claim_token=$3 AND operation_token=$4 AND status=\'sending\' AND ' +
      (delivery.kind === 'whatsapp_messages' ? 'instance' : "snapshot->>'instance'") + '=$5',
      [delivery.id,context.assinaturaId,delivery.claimToken,context.operationToken,context.instanceName]);
    if (match.rowCount !== 1) return false;
  }
  if (renew) {
    const renewed = await client.query('UPDATE ' + s + ".evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1 RETURNING state", [context.executionId]);
    return renewed.rows[0]?.state === 'ACTIVE';
  }
  // Recheck after reads/lock waits; time always belongs to PostgreSQL.
  const valid = await client.query('SELECT state=\'ACTIVE\' AND lease_until>clock_timestamp() AS valid FROM ' + s + '.evolution_execution_authorizations WHERE execution_id=$1', [context.executionId]);
  if (!valid.rows[0]?.valid) {
    await client.query('UPDATE ' + s + ".evolution_execution_authorizations SET state='UNKNOWN' WHERE execution_id=$1 AND state='ACTIVE'", [context.executionId]);
    return false;
  }
  return true;
}

// No STOPPED, release, reconciliation or recovery API belongs to this module.
module.exports = { processIdentity, deliveryIdentity, registerExecution, checkAuthorization };
