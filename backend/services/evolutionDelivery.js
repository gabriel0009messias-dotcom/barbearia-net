const { randomUUID } = require('node:crypto');
const { createEvolutionOwnershipOperation } = require('./evolutionOwnershipOperation');
const { acceptedEvolutionMessage } = require('../evolutionApi');
const { executionScope: scope } = require('./executionScope');
const tables = new Set(['whatsapp_messages', 'appointment_reminders']);
const activeTransports = new Set();
const executionSlots = new WeakMap();
const executionKey = token => 'studiofy.delivery.execution:' + token;
const safeBeforeRequest = error => error?.deliveryOutcome === 'not_attempted' ||
  ['EVOLUTION_NOT_CONFIGURED','EVOLUTION_INVALID_URL'].includes(error?.code) ||
  (error?.code === 'EVOLUTION_RATE_LIMIT' && error.rateLimitSource === 'local_cooldown');

function createEvolutionDelivery(db, { schema = process.env.DATABASE_SCHEMA || 'salaoflix', timeoutMs = 15000 } = {}) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid delivery schema.');
  const qualified = table => { if (!tables.has(table)) throw new Error('Invalid delivery kind.'); return '"' + schema + '".' + table; };
  const operation = () => createEvolutionOwnershipOperation(db.pool, { schema });
  const owners = '"' + schema + '".evolution_instance_owners';

  // Keep the execution guard until the actual callback settles, even when the
  // ownership deadline has already quarantined the delivery. A session lock
  // also rejects administrative abandonment from another process. The internal
  // stopped attestation remains mandatory (including for pre-guard executions
  // and after a database connection loss); neither a TTL nor a free lock proves
  // that an old execution stopped.
  async function guardedTransport(context, work) {
    // Leave two pool slots for frontier writes and ownership/finalization. A
    // saturated guard budget fails before transport and uses normal recovery.
    const slots = executionSlots.get(db.pool) || 0;
    if (slots >= Math.max(0,(db.pool.options?.max || 5)-2)) throw new Error('Delivery execution capacity unavailable.');
    executionSlots.set(db.pool,slots+1);
    let connection;
    let held = false, broken = false;
    const onError = () => { broken = true; };
    try {
      connection = await db.pool.connect();
      connection.on('error', onError);
      context.assertActive();
      const result = await connection.query({ text: 'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', values: [executionKey(context.operationToken)], query_timeout: 2500 });
      if (!result.rows[0].held) throw new Error('Delivery execution is active.');
      held = true;
      activeTransports.add(context.operationToken);
      context.assertActive();
      return await scope.follow('delivery.transport', work);
    } finally {
      activeTransports.delete(context.operationToken);
      if (held && !broken) {
        try { await connection.query({ text: 'SELECT pg_advisory_unlock(hashtextextended($1,0))', values: [executionKey(context.operationToken)], query_timeout: 2500 }); }
        catch { broken = true; }
      }
      if (connection) {
        connection.removeListener('error', onError);
        connection.release(broken);
      }
      executionSlots.set(db.pool,(executionSlots.get(db.pool) || 1)-1);
    }
  }

  // Revoke the claim atomically. An old paused worker cannot cross the durable
  // transport frontier with the revoked claim after recovery commits.
  async function recoverUnstarted(table, original, delayMs = 30000) {
    if (!scope.isOpen()) return false;
    const target = qualified(table);
    for (let attempt = 0; attempt < 2; attempt++) {
      const row = await db.getAsync('SELECT * FROM ' + target + ' WHERE id=$1', [original.id]);
      if (!row || row.status !== 'sending' || !row.claim_token || row.claim_token !== original.claim_token || row.dispatch_started_at) return false;
      if (row.operation_token) {
        const authorization = await db.getAsync('SELECT a.authorization_state FROM "' + schema + '".evolution_execution_authorization_status a JOIN "' + schema + '".evolution_operation_executions e USING(execution_id) WHERE e.operation_token=$1', [row.operation_token]);
        if (authorization?.authorization_state === 'UNKNOWN') return false;
      }
      const sql = 'UPDATE ' + target + " SET status='pending',claim_token=$1,operation_token=NULL,claimed_at=NULL,last_error='Transport not started; safely deferred.'," +
        (table === 'whatsapp_messages' ? 'lease_until=$2' : 'next_attempt_at=$2') +
        " WHERE id=$3 AND claim_token IS NOT DISTINCT FROM $4::uuid AND status='sending' AND dispatch_started_at IS NULL AND operation_token IS NOT DISTINCT FROM $5::uuid RETURNING id";
      const values = [randomUUID(), table === 'whatsapp_messages' ? Date.now() + delayMs : new Date(Date.now() + delayMs), row.id, row.claim_token, row.operation_token];
      if (!row.operation_token) {
        if (!scope.isOpen()) return false;
        const changed = await db.runAsync(sql, values);
        if (changed.changes === 1) return true;
        continue; // A reservation COMMIT may have completed while we waited.
      }
      try {
        scope.assertOpen();
        // Here "stopped" is proven by the absent durable frontier AND atomic
        // revocation, not by a timeout or an assumption that a process died.
        await operation().acknowledgeStoppedOperation(row.assinatura_id, row.operation_token, async client => {
          const current = (await client.query('SELECT * FROM ' + target + ' WHERE id=$1 FOR UPDATE', [row.id])).rows[0];
          if (!current || current.status !== 'sending' || current.claim_token !== row.claim_token || current.operation_token !== row.operation_token || current.dispatch_started_at) throw new Error('Delivery already started or revoked.');
          const authorization = (await client.query('SELECT a.state,a.lease_until FROM "' + schema + '".evolution_execution_authorizations a JOIN "' + schema + '".evolution_operation_executions e USING(execution_id) WHERE e.operation_token=$1 FOR UPDATE OF a', [row.operation_token])).rows[0];
          if (authorization && (authorization.state !== 'ACTIVE' || !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[authorization.lease_until])).rows[0].valid)) throw new Error('Execution authorization unavailable.');
          const changed = await client.query(sql, values);
          if (changed.rowCount !== 1) throw new Error('Delivery recovery mismatch.');
        });
        return true;
      } catch { return false; }
    }
    return false;
  }

  async function recoverInterrupted(table, cutoff = new Date(Date.now() - 120000)) {
    const target = qualified(table);
    await db.runAsync('UPDATE ' + target + " SET status='uncertain',dispatch_started_at=coalesce(dispatch_started_at,CURRENT_TIMESTAMP),last_error='Legacy delivery requires explicit reconciliation.' WHERE (status='pending' AND (dispatch_started_at IS NOT NULL OR (attempts>0 AND claim_token IS NULL))) OR (status='sending' AND claim_token IS NULL)");
    for (let i = 0; i < 50; i++) {
      const row = await db.transaction(client => client.getAsync('SELECT * FROM ' + target + " WHERE status='sending' AND (claimed_at IS NULL OR claimed_at<$1) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED", [cutoff]), { serialize: false });
      if (!row) return;
      if (!row.dispatch_started_at) {
        if (!await recoverUnstarted(table, row, 0)) return;
      } else {
        await db.runAsync('UPDATE ' + target + " SET status='uncertain',last_error='Interrupted delivery requires reconciliation.' WHERE id=$1 AND claim_token IS NOT DISTINCT FROM $2::uuid AND status='sending' AND dispatch_started_at IS NOT NULL", [row.id, row.claim_token]);
      }
    }
  }

  async function dispatch(table, row, send, { validate = async () => true } = {}) {
    const target = qualified(table), token = row.claim_token;
    // Only current workers create a UUID claim. Unclaimed legacy records must
    // pass through quarantine/reconciliation, never infer safety from NULLs.
    if (typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) return;
    const acceptedAt = table === 'whatsapp_messages' ? 'CURRENT_TIMESTAMP::text' : 'CURRENT_TIMESTAMP';
    try {
      // Capacity rejection precedes acquiring a new authorization. It retains
      // the existing safe, unreserved pre-transport deferral behavior.
      if ((executionSlots.get(db.pool) || 0) >= Math.max(0,(db.pool.options?.max || 5)-2)) throw new Error('Delivery execution capacity unavailable.');
      await operation().run(row.assinatura_id, async context => guardedTransport(context, async () => {
        if (!await validate()) return { status: 'failed', reason: 'Delivery no longer authorized.' };
        context.assertActive();
        await context.authorizeEffect();
        // Write-ahead intent is the frontier: AFTER its commit HTTP may start.
        // A lost acknowledgement of this write never authorizes calling send.
        scope.assertOpen();
        const started = await db.runAsync('UPDATE ' + target +
          ' SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1 WHERE id=$1 AND assinatura_id=$2 AND claim_token=$3 AND operation_token=$4' +
          " AND status='sending' AND dispatch_started_at IS NULL AND EXISTS(SELECT 1 FROM " + owners + ' WHERE operation_token=$4 AND model=$5 AND source_schema=$6 AND owner_id=$7)',
          [row.id,row.assinatura_id,token,context.operationToken,'principal',schema,String(row.assinatura_id)]);
        if (started.changes !== 1) throw new Error('Delivery claim no longer active.');
        context.assertActive();
        scope.assertOpen();
        if(table==='whatsapp_messages') require('./whatsapp/diagnostics').diagnostic('delivery_started',{deliveryId:String(row.id)});
        let result;
        try { result = await send(context.instanceName,row.phone,row.response); }
        catch (failure) {
          context.assertActive();
          if (safeBeforeRequest(failure)) return { status: 'pending', reason: 'Delivery deferred before transport.' };
          if (failure?.deliveryOutcome === 'rejected') return { status: 'failed', reason: 'Provider rejected the request.' };
          throw failure;
        }
        context.assertActive();
        if (!acceptedEvolutionMessage(result)) throw new Error('Unconfirmed provider acceptance.');
        if(table==='whatsapp_messages') require('./whatsapp/diagnostics').diagnostic('delivery_accepted',{deliveryId:String(row.id)});
        return { status: 'sent', reason: null };
      }), { expectedInstance: row.instance, timeoutMs,
        delivery: { kind: table, id: row.id, claimToken: token }, onReserved: async (client, context) => {
        const claim = (await client.query('SELECT * FROM ' + target + ' WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
        if (!claim || claim.status !== 'sending' || claim.claim_token !== token || claim.assinatura_id !== row.assinatura_id || claim.dispatch_started_at ||
          (table === 'whatsapp_messages' && (claim.instance !== row.instance || claim.phone !== row.phone || claim.response !== row.response))) throw Object.assign(new Error('Delivery claim mismatch.'),{code:'INSTANCE_DELIVERY_CLAIM_MISMATCH'});
        await client.query('UPDATE ' + target + ' SET operation_token=$1 WHERE id=$2',[context.operationToken,row.id]);
      }, onCompleted: async (client, context, result) => {
        if (!result || !['sent','failed','pending'].includes(result.status)) throw new Error('Invalid delivery result.');
        const completed = await client.query('UPDATE ' + target +
          ' SET status=$1,last_error=$2,dispatch_started_at=CASE WHEN $1=\'pending\' THEN NULL ELSE dispatch_started_at END,sent_at=CASE WHEN $1=\'sent\' THEN ' + acceptedAt +
          " ELSE sent_at END WHERE id=$3 AND assinatura_id=$4 AND claim_token=$5 AND operation_token=$6 AND status='sending' RETURNING id",
          [result.status,result.reason,row.id,row.assinatura_id,token,context.operationToken]);
        if (completed.rowCount !== 1) throw new Error('Delivery finalization mismatch.');
        if (result.status === 'pending') {
          if (table === 'whatsapp_messages') await client.query('UPDATE ' + target + ' SET lease_until=$1 WHERE id=$2',[Date.now()+30000,row.id]);
          else await client.query('UPDATE ' + target + " SET next_attempt_at=CURRENT_TIMESTAMP+interval '30 seconds' WHERE id=$1",[row.id]);
        }
      }});
    } catch (failure) {
      // Drain never initiates claim recovery, releases a fence or schedules retry.
      if (!scope.isOpen()) failure.authorizationLost = true;
      if (['INSTANCE_NOT_CONFIGURED','INSTANCE_INVALID','INSTANCE_OWNER_MISMATCH','INSTANCE_AMBIGUOUS','INSTANCE_INVALID_TENANT','INSTANCE_DELIVERY_CLAIM_MISMATCH'].includes(failure.code)) {
        await db.runAsync('UPDATE ' + target + " SET status='failed',last_error='Instance ownership could not be confirmed.' WHERE id=$1 AND claim_token=$2 AND status='sending' AND dispatch_started_at IS NULL",[row.id,token]);
      } else if (failure.authorizationLost || !await recoverUnstarted(table, row)) {
        await db.runAsync('UPDATE ' + target + " SET status='uncertain',last_error='Operation requires explicit reconciliation.' WHERE id=$1 AND claim_token=$2 AND status='sending' AND (dispatch_started_at IS NOT NULL OR operation_token IS NOT NULL)",[row.id,token]);
      }
    }
  }

  // INTERNAL ONLY: stopped and outcome are verified operator attestations.
  async function reconcile(table, id, tenant, operationToken, { stopped, outcome, expectedInstance } = {}) {
    const target = qualified(table);
    if (stopped !== true || !['accepted','rejected','not_accepted','abandoned_unknown'].includes(outcome)) throw new Error('Explicit verified reconciliation required.');
    const unknown = outcome === 'abandoned_unknown';
    if (unknown && (!operationToken || typeof expectedInstance !== 'string' || !expectedInstance || activeTransports.has(operationToken))) throw new Error('Explicit stopped execution and instance required.');
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(tenant) || tenant <= 0 || (operationToken !== null && (typeof operationToken !== 'string' || !/^[a-f0-9-]{36}$/.test(operationToken)))) throw new Error('Delivery reconciliation mismatch.');
    const receipts = '"' + schema + '".evolution_delivery_reconciliations';
    const key = operationToken ? 'operation:' + operationToken : 'legacy:' + table + ':' + id;
    const alreadyReconciled = async () => {
      let receipt = await db.getAsync('SELECT * FROM ' + receipts + ' WHERE receipt_key=$1',[key]);
      if (!receipt) {
        receipt = await db.getAsync('SELECT * FROM ' + receipts + " WHERE delivery_kind=$1 AND delivery_id=$2 AND assinatura_id=$3 AND outcome='abandoned_unknown'",[table,id,tenant]);
        if (!receipt) return false;
      }
      if (receipt.delivery_kind !== table || receipt.delivery_id !== id || receipt.assinatura_id !== tenant || receipt.outcome !== outcome || receipt.operation_token !== operationToken || (unknown && receipt.instance_name !== expectedInstance)) throw new Error('Delivery reconciliation mismatch.');
      return true;
    };
    if (await alreadyReconciled()) return;
    const finish = async client => {
      if ((await client.query('SELECT receipt_key FROM ' + receipts + " WHERE delivery_kind=$1 AND delivery_id=$2 AND assinatura_id=$3 AND outcome='abandoned_unknown'",[table,id,tenant])).rows.length) throw new Error('Delivery reconciliation mismatch.');
      if (unknown) {
        const guard = await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',[executionKey(operationToken)]);
        if (!guard.rows[0].held || activeTransports.has(operationToken)) throw new Error('Delivery execution is active.');
        const owner = (await client.query('SELECT instance_name FROM ' + owners + ' WHERE model=$1 AND source_schema=$2 AND owner_id=$3 AND operation_token=$4', ['principal',schema,String(tenant),operationToken])).rows[0];
        if (!owner || owner.instance_name !== expectedInstance) throw new Error('Delivery reconciliation mismatch.');
      }
      const row = (await client.query('SELECT * FROM ' + target + ' WHERE id=$1 AND assinatura_id=$2 FOR UPDATE',[id,tenant])).rows[0];
      if (!row || !['uncertain','sent','failed'].includes(row.status) || row.operation_token !== operationToken ||
        (operationToken && !row.claim_token) || (row.status === 'sent' && outcome !== 'accepted') || (row.status === 'failed' && outcome !== 'rejected')) throw new Error('Delivery reconciliation mismatch.');
      if (unknown && (row.status !== 'uncertain' || !row.dispatch_started_at || !(row.attempts > 0) || row.sent_at || (table === 'whatsapp_messages' && row.instance !== expectedInstance))) throw new Error('Delivery reconciliation mismatch.');
      if (unknown && table === 'whatsapp_messages' && (await client.query('SELECT delivery_id FROM "' + schema + '".whatsapp_conversation_responses WHERE delivery_id=$1 AND assinatura_id=$2 AND provider_message_id IS NOT NULL FOR UPDATE',[id,tenant])).rows.length) throw new Error('Provider acceptance evidence requires conclusive reconciliation.');
      await client.query("SELECT set_config('studiofy.delivery_reconciliation',$1,true)",[row.claim_token || 'legacy:' + table + ':' + id]);
      await client.query('UPDATE ' + target + " SET status=$1,last_error=$4,operation_token=NULL,claim_token=CASE WHEN $1='pending' THEN $3::uuid ELSE NULL END,claimed_at=CASE WHEN $5 THEN claimed_at ELSE NULL END,dispatch_started_at=CASE WHEN $1='pending' THEN NULL ELSE dispatch_started_at END,sent_at=CASE WHEN $1='sent' THEN coalesce(sent_at," + (table === 'whatsapp_messages' ? 'CURRENT_TIMESTAMP::text' : 'CURRENT_TIMESTAMP') + ') ELSE sent_at END WHERE id=$2',
        [outcome==='accepted'?'sent':outcome==='rejected'||unknown?'failed':'pending',id,randomUUID(),unknown?'Administratively abandoned; provider outcome unknown; retry prohibited.':null,unknown]);
      await client.query('INSERT INTO ' + receipts + '(receipt_key,operation_token,delivery_kind,delivery_id,assinatura_id,claim_token,outcome,instance_name,previous_last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[key,operationToken,table,id,tenant,row.claim_token,outcome,unknown?expectedInstance:null,unknown?row.last_error:null]);
    };
    try {
      if (operationToken) await operation().acknowledgeStoppedOperation(tenant,operationToken,finish);
      else {
        const row = await db.getAsync('SELECT * FROM ' + target + ' WHERE id=$1 AND assinatura_id=$2',[id,tenant]);
        if (!row) throw new Error('Delivery reconciliation mismatch.');
        await operation().reconcileUnreservedOperation(tenant,finish,{ expectedInstance: table === 'whatsapp_messages' ? row.instance : undefined });
      }
    } catch (failure) { if (!await alreadyReconciled()) throw failure; }
  }
  return {
    dispatch: (...args) => scope.admit('delivery.dispatch', () => dispatch(...args)),
    reconcile: (...args) => scope.admit('delivery.reconcile', () => reconcile(...args)),
    recoverInterrupted: (...args) => scope.admit('delivery.recovery', () => recoverInterrupted(...args)),
  };
}
module.exports = { createEvolutionDelivery, newDeliveryClaim: randomUUID };
