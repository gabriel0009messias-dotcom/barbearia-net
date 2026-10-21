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

// Stage 1 deliberately exports no heartbeat, STOPPED, release or recovery API.
module.exports = { processIdentity, deliveryIdentity, registerExecution };
