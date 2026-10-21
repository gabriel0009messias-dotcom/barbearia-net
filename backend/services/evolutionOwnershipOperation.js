const { AsyncLocalStorage } = require('node:async_hooks');
const execution = new AsyncLocalStorage();
const { randomUUID } = require('node:crypto');
const { createEvolutionOwnershipResolver } = require('./evolutionOwnership');
const { deliveryIdentity, registerExecution, checkAuthorization } = require('./executionLifecycle');
const { executionScope: scope } = require('./executionScope');
let shuttingDown = false;
function stopExecutionAuthorization() { shuttingDown = true; scope.beginDrain(); }
const error = code => Object.assign(new Error('Evolution ownership operation could not be completed.'), { code });

// Internal API only: callers provide an authenticated/internal tenant, never a
// request-selected provider name. This module does not import any transport.
function createEvolutionOwnershipOperation(pool, { schema = process.env.DATABASE_SCHEMA || 'salaoflix' } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw error('INSTANCE_INVALID_SCHEMA');
  const s = '"' + schema + '"';
  async function transaction(work) {
    return scope.follow('ownership.sql', () => transactionBody(work));
  }
  async function transactionBody(work) {
    let client, abandoned = false, timer;
    try {
      client = await Promise.race([
        scope.follow('ownership.connection', () => pool.connect().then(c => { if (abandoned) { c.release(); throw error('INSTANCE_OPERATION_BUSY'); } return c; })),
        new Promise((_, reject) => { timer = setTimeout(() => { abandoned = true; reject(error('INSTANCE_OPERATION_BUSY')); }, 2000); }),
      ]);
    } catch (cause) {
      throw error(cause?.code === 'INSTANCE_OPERATION_BUSY' ? 'INSTANCE_OPERATION_BUSY' : 'INSTANCE_OPERATION_FAILED');
    } finally { clearTimeout(timer); }
    const connection = client;
    client = { query: (text, values) => connection.query({ text, values, query_timeout: 2500 }) };
    let broken = false;
    const onError = () => { broken = true; };
    connection.on('error', onError);
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (cause) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (typeof cause?.code === 'string' && cause.code.startsWith('INSTANCE_')) throw cause;
      throw error('INSTANCE_OPERATION_FAILED');
    } finally { connection.removeListener('error', onError); connection.release(broken); }
  }
  async function locked(client, tenant, expectedInstance) {
    if (!Number.isSafeInteger(tenant) || tenant <= 0) throw error('INSTANCE_INVALID_TENANT');
    // Same lock order as association writers: source first, canonical registry next.
    await client.query('SELECT id FROM ' + s + '.assinaturas WHERE id=$1 FOR UPDATE', [tenant]);
    const db = { getAsync: async (...args) => (await client.query(...args)).rows[0],
      allAsync: async (...args) => (await client.query(...args)).rows };
    const owner = await createEvolutionOwnershipResolver(db, { schema }).resolve(tenant, { expectedInstance });
    const record = (await client.query('SELECT operation_token FROM ' + s + '.evolution_instance_owners WHERE instance_key=$1 COLLATE "C" FOR UPDATE', [owner.instanceName.toLowerCase()])).rows[0];
    if (!record) throw error('INSTANCE_AMBIGUOUS');
    return { owner, record };
  }
  async function release(tenant, operationToken, reconcile) {
    if (!Number.isSafeInteger(tenant) || tenant <= 0) throw error('INSTANCE_INVALID_TENANT');
    if (typeof operationToken !== 'string' || !/^[a-f0-9-]{36}$/.test(operationToken)) throw error('INSTANCE_OPERATION_MISMATCH');
    return transaction(async client => {
      const { record } = await locked(client, tenant);
      if (record.operation_token !== operationToken) throw error('INSTANCE_OPERATION_MISMATCH');
      // No-op for current/unbound boots. Bound boots lock delivery/correlation
      // before gate and authorization; proof acceptance never locks business rows.
      await client.query('SELECT ' + s + '.studiofy_execution_lock_finalization($1)', [operationToken]);
      if (reconcile !== undefined) {
        if (typeof reconcile !== 'function') throw error('INSTANCE_INVALID_OPERATION');
        await reconcile(client);
      }
      await client.query('UPDATE ' + s + '.evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL WHERE model=$1 AND source_schema=$2 AND owner_id=$3 AND operation_token=$4', ['principal', schema, String(tenant), operationToken]);
    });
  }
  async function run(tenant, operation, { timeoutMs = 5000, expectedInstance, onReserved, onCompleted, delivery } = {}) {
    if (shuttingDown) throw error('INSTANCE_AUTHORIZATION_UNAVAILABLE');
    if (!Number.isSafeInteger(tenant) || tenant <= 0) throw error('INSTANCE_INVALID_TENANT');
    if ((onReserved !== undefined && typeof onReserved !== 'function') || (onCompleted !== undefined && typeof onCompleted !== 'function') || typeof operation !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) throw error('INSTANCE_INVALID_OPERATION');
    const binding = deliveryIdentity(delivery);
    const token = randomUUID();
    const owner = await transaction(async client => {
      const { owner, record } = await locked(client, tenant, expectedInstance);
      scope.assertOpen();
      if (record.operation_token) throw error('INSTANCE_OPERATION_BUSY');
      await client.query('UPDATE ' + s + '.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE instance_key=$2 COLLATE "C"', [token, owner.instanceName.toLowerCase()]);
      // Optional persistence hook is SQL-only: delivery claim and reservation commit atomically.
      if (onReserved) await onReserved(client, { ...owner, operationToken: token });
      scope.assertOpen();
      const identity = await registerExecution(client, schema, owner, token, binding);
      scope.assertOpen();
      return { ...owner, ...identity };
    });
    scope.bindExecution(owner);
    // Reservation commits BEFORE invoking the operation. All association writers
    // are fenced by migration 018, even across models/processes or after a crash.
    const controller = new AbortController();
    let timer, heartbeatTimer, active = true, authorizationDenied = false, heartbeatInFlight;
    const assertActive = () => { if (!active || controller.signal.aborted) throw error('INSTANCE_OPERATION_EXPIRED'); };
    const identity = Object.freeze({ ...owner, operationToken: token });
    const authorization = async options => {
      const allowed = await transaction(async client => {
        const { record } = await locked(client, tenant, owner.instanceName);
        if (record.operation_token !== token) return false;
        if (options?.renew && (!active || shuttingDown || !scope.isOpen())) return false;
        const allowed = await checkAuthorization(client, schema, identity, binding, options);
        if (options?.renew && (!active || shuttingDown || !scope.isOpen())) throw error('INSTANCE_AUTHORIZATION_UNAVAILABLE');
        return allowed;
      });
      return allowed;
    };
    const deny = () => { authorizationDenied = true; active = false; /* Never abort an already authorized HTTP call for lease loss. */ };
    const authorizeEffect = async () => {
      assertActive();
      try {
        scope.assertOpen();
        if (shuttingDown || !await authorization()) throw error('INSTANCE_AUTHORIZATION_UNAVAILABLE');
        scope.assertOpen();
        if (shuttingDown) throw error('INSTANCE_AUTHORIZATION_UNAVAILABLE');
        assertActive();
      } catch { deny(); throw error('INSTANCE_AUTHORIZATION_UNAVAILABLE'); }
    };
    const heartbeat = async () => {
      if (!active || shuttingDown || !scope.isOpen()) { deny(); return; }
      try { if (!await authorization({ renew: true })) deny(); }
      catch { deny(); }
    };
    try {
      const context = Object.freeze({ ...identity, signal: controller.signal, assertActive, authorizeEffect });
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
        active = false; controller.abort(); reject(error('INSTANCE_OPERATION_TIMEOUT'));
      }, timeoutMs); });
      heartbeatTimer = setInterval(() => {
        if (!heartbeatInFlight && active && scope.isOpen()) heartbeatInFlight = scope.follow('ownership.heartbeat', heartbeat).finally(() => { heartbeatInFlight = undefined; });
      }, 3000);
      heartbeatTimer.unref();
      const result = await Promise.race([scope.follow('ownership.callback', async () => { await authorizeEffect(); return execution.run(context, () => operation(context)); }), timeout]);
      assertActive(); active = false; clearTimeout(timer);
      // Transport has ended. Finalize its persisted result and release the fence
      // in ONE short, SQL-only transaction, bounded by the database timeouts.
      // A failure rolls back both facts; a lost COMMIT acknowledgement cannot
      // leave a terminal delivery with an orphan reservation.
      await release(tenant, token, async client => {
        if (onCompleted) await onCompleted(client, { ...owner, operationToken: token }, result);
        // Successful existing finalization ends authorization, not evidence of
        // executor death. It commits together with result/fence finalization.
        await client.query('UPDATE ' + s + ".evolution_execution_authorizations SET state='UNKNOWN' WHERE execution_id=$1 AND state='ACTIVE'", [owner.executionId]);
      });
      return result;
    } catch (cause) {
      // An exception/timeout may follow provider acceptance. Do not expire or
      // silently release this durable fence. No retry or new owner is authorized.
      if (cause?.code === 'INSTANCE_ADMISSION_CLOSED' || !scope.isOpen()) authorizationDenied = true;
      active = false;
      // Best effort persistence only. Failure cannot restore local authority or
      // release a fence. The effective-state view also handles crashed processes.
      // Other errors may be conclusively PRE-TRANSPORT. Preserve the existing
      // atomic claim-revocation recovery, which now also checks permission.
      if (authorizationDenied || !binding) {
        try { await authorization({ revoke: true }); } catch { /* PostgreSQL may be unavailable. */ }
      }
      const failure = error(cause?.code === 'INSTANCE_OPERATION_TIMEOUT' ? 'INSTANCE_OPERATION_TIMEOUT' : 'INSTANCE_OPERATION_UNCERTAIN');
      failure.operationToken = token;
      failure.authorizationLost = authorizationDenied;
      throw failure;
    } finally { active = false; clearTimeout(timer); clearInterval(heartbeatTimer); controller.abort(); }
  }
  // Privileged INTERNAL reconciliation only, after verifying the old execution
  // has stopped and its outcome. Never expose this as a customer HTTP endpoint,
  // use a TTL, or release merely because the original deadline passed.
  // SQL-only legacy reconciliation: lock the real owner and never clear any
  // current reservation. The callback cannot perform provider I/O.
  async function reconcileUnreservedOperation(tenant, work, { expectedInstance } = {}) {
    if (typeof work !== 'function') throw error('INSTANCE_INVALID_OPERATION');
    return transaction(async client => {
      const { owner, record } = await locked(client, tenant, expectedInstance);
      if (record.operation_token) throw error('INSTANCE_OPERATION_BUSY');
      return work(client, owner);
    });
  }
  const trackedRun = (...args) => {
    if (!scope.isOpen()) {
      const failure = error('INSTANCE_AUTHORIZATION_UNAVAILABLE'); failure.authorizationLost = true;
      return Promise.reject(failure);
    }
    return scope.admit('ownership.operation', () => run(...args));
  };
  return Object.freeze({ run: trackedRun, acknowledgeStoppedOperation: release, reconcileUnreservedOperation });
}
function assertEvolutionOperation(instanceName) {
  const context = execution.getStore();
  if (!context || context.instanceName !== instanceName) throw error('INSTANCE_OPERATION_REQUIRED');
  context.assertActive();
  return context;
}
async function authorizeEvolutionEffect(instanceName, { required = true } = {}) {
  if (!execution.getStore() && !required) return null; // Existing non-execution callers.
  const context = assertEvolutionOperation(instanceName);
  await context.authorizeEffect();
  return context;
}
module.exports = { createEvolutionOwnershipOperation, assertEvolutionOperation, authorizeEvolutionEffect, stopExecutionAuthorization };
