const { localMoment } = require('./agenda');
const { executionScope: scope } = require('./executionScope');
const { avaliarAcessoAssinatura } = require('./access');
const { createEvolutionOwnershipResolver } = require('./evolutionOwnership');
const { composeMessage } = require('./returnReminderDispatcher');

const INTERVAL_MS = 60000;
const registry = new WeakMap();
function installed(schema) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid return schema');
  return '"' + schema + '"';
}
function inProcessingWindow(now) {
  const { time } = localMoment(new Date(now));
  return time >= '09:00' && time < '18:00';
}
function access(client) {
  return {
    getAsync: async (sql, values) => (await client.query(sql, values)).rows[0],
    allAsync: async (sql, values) => (await client.query(sql, values)).rows,
  };
}

// This producer has no transport, claim, attempt counter, or delivery recovery.
// A single transaction durably binds each business opportunity to its outbox.
function createReturnReminderWorker(db, {
  schema = process.env.DATABASE_SCHEMA || 'salaoflix', limit = 50, dispatcher,
} = {}) {
  const s = installed(schema);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid return batch size');
  if (dispatcher !== undefined) throw new Error('Return worker only materializes the official outbox');
  let stopped = false, active;

  async function materialize(candidate) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='1s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      const group = [candidate.assinatura_id, candidate.customer_key, candidate.service_identity];
      const { locked } = (await client.query(`SELECT pg_try_advisory_xact_lock(${s}.studiofy_return_group_key($1,$2,$3)) AS locked`, group)).rows[0];
      if (!locked) { await client.query('ROLLBACK'); return 'busy'; }
      await client.query(`SELECT ${s}.studiofy_return_supersede_group($1,$2,$3)`, group);
      const row = (await client.query(`SELECT * FROM ${s}.return_reminders WHERE id=$1 AND assinatura_id=$2 FOR UPDATE NOWAIT`,
        [candidate.id, candidate.assinatura_id])).rows[0];
      if (!row) { await client.query('COMMIT'); return 'skipped'; }
      const ready = (await client.query(`SELECT ${s}.studiofy_return_rule_ready(r) AND ${s}.studiofy_return_delivery_open()
        AND materialized_at IS NULL AS ready FROM ${s}.return_reminders r WHERE id=$1`, [row.id])).rows[0].ready;
      if (!ready) { await client.query('COMMIT'); return 'skipped'; }
      const account = (await client.query(`SELECT * FROM ${s}.assinaturas WHERE id=$1`, [row.assinatura_id])).rows[0];
      const service = (await client.query(`SELECT ativo FROM ${s}.servicos_assinatura WHERE id=$1 AND assinatura_id=$2`,
        [row.service_identity.slice(8), row.assinatura_id])).rows[0];
      const now = (await client.query(`SELECT ${s}.studiofy_return_now() AS now`)).rows[0].now;
      const reason = !account || !avaliarAcessoAssinatura(account, +now).liberado ? 'account_unavailable'
        : !service?.ativo ? 'unavailable_service' : null;
      if (reason) {
        await client.query(`UPDATE ${s}.return_reminders SET status='cancelled',reason_code=$2,updated_at=clock_timestamp() WHERE id=$1`, [row.id, reason]);
        await client.query('COMMIT'); return 'cancelled';
      }
      let owner;
      try { owner = await createEvolutionOwnershipResolver(access(client), { schema }).resolve(row.assinatura_id); }
      catch {
        await client.query(`UPDATE ${s}.return_reminders SET next_attempt_at=${s}.studiofy_return_now()+interval '1 minute',updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
        await client.query('COMMIT'); return 'ownership_unavailable';
      }
      const epoch = (await client.query(`SELECT conversation_epoch FROM ${s}.evolution_instance_owners
        WHERE instance_key=lower($1) COLLATE "C" AND instance_name=$1 AND model='principal' AND source_schema=$2 AND owner_id=$3`,
      [owner.instanceName, schema, String(row.assinatura_id)])).rows[0]?.conversation_epoch;
      const response = await composeMessage(access(client), row.id, { schema });
      await client.query(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,return_reminder_id,return_owner_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(return_reminder_id) WHERE return_reminder_id IS NOT NULL DO NOTHING`,
      [row.assinatura_id, owner.instanceName, row.phone_snapshot, 'return_reminder:' + row.id, response, row.id, epoch]);
      await client.query(`UPDATE ${s}.return_reminders SET materialized_at=COALESCE(materialized_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1`, [row.id]);
      await client.query('COMMIT'); return 'materialized';
    } catch (error) {
      await client.query('ROLLBACK');
      if (['55P03', '40P01'].includes(error.code)) return 'busy';
      throw error;
    } finally { client.release(); }
  }
  async function run() {
    await db.ready;
    if (!(await db.pool.query(`SELECT ${s}.studiofy_return_delivery_open() AS ready`)).rows[0].ready) return [];
    const { rows } = await db.pool.query(`SELECT id,assinatura_id,customer_key,service_identity FROM ${s}.return_reminders
      WHERE transport_protocol='outbox_v1' AND status='pending' AND materialized_at IS NULL
      AND eligible_at<=${s}.studiofy_return_now() AND next_attempt_at<=${s}.studiofy_return_now()
      ORDER BY next_attempt_at,id LIMIT $1`, [limit]);
    const results = [];
    for (const row of rows) { if (stopped || !scope.isOpen()) break; results.push(await materialize(row)); }
    return results;
  }
  function drain() {
    if (stopped) return Promise.resolve([]);
    if (!active) {
      const task = scope.admit('return.materialize', run);
      if (!task.completion) return task;
      active = { result: task, completion: task.completion };
      task.completion.then(() => { active = undefined; });
    }
    return active.result;
  }
  async function stop() { stopped = true; await active?.completion; }
  return { drain, stop };
}
function materializeReturnReminders(db, options) { return createReturnReminderWorker(db, options).drain(); }

async function validateReturnReminder(db, row, { schema = process.env.DATABASE_SCHEMA || 'salaoflix' } = {}) {
  if (row.return_reminder_id == null) return true;
  const s = installed(schema);
  const state = await db.getAsync(`SELECT ${s}.studiofy_return_rule_ready(r) AS ready,
    ${s}.studiofy_return_delivery_open() AS open,
    EXISTS(SELECT 1 FROM ${s}.servicos_assinatura v WHERE v.assinatura_id=r.assinatura_id
      AND v.id=substring(r.service_identity FROM 9)::bigint AND v.ativo) AS service_active,
    EXISTS(SELECT 1 FROM ${s}.whatsapp_messages m WHERE m.return_reminder_id=r.id
      AND m.assinatura_id=r.assinatura_id AND m.return_cancel_requested_at IS NULL
      AND EXISTS(SELECT 1 FROM ${s}.evolution_instance_owners o WHERE o.model='principal' AND o.source_schema=$3
        AND o.owner_id=r.assinatura_id::text AND o.instance_name=m.instance AND o.conversation_epoch=m.return_owner_epoch)) AS bound
    FROM ${s}.return_reminders r WHERE id=$1 AND assinatura_id=$2`, [row.return_reminder_id, row.assinatura_id, schema]);
  if (!state || !state.ready || !state.bound || !state.service_active) return false;
  // Throwing defers the existing unstarted claim. Returning false would fail it.
  if (!state.open) throw Object.assign(new Error('Return delivery deferred'), { code: 'RETURN_DELIVERY_DEFERRED' });
  return state.ready && state.service_active;
}

function startWorker(db, options = {}) {
  scope.assertOpen();
  if (registry.has(db)) return registry.get(db);
  const worker = createReturnReminderWorker(db, options);
  let stopped = false;
  const completions = new Set();
  const run = () => {
    if (stopped || !scope.isOpen()) return;
    const task = scope.admitRoot('return.run', () => worker.drain().catch(() => console.error('[Studiofy] Falha ao materializar retornos.')), { canAdmit: () => !stopped });
    completions.add(task.completion);
    task.completion.then(() => completions.delete(task.completion));
    return task;
  };
  const timer = setInterval(run, INTERVAL_MS); timer.unref();
  const handle = { stop: require('./executionCapabilities').coordinatorFor(scope).register('scheduler.return-reminders', async () => {
    stopped = true; clearInterval(timer);
    try { await worker.stop(); await Promise.all([...completions]); }
    finally { registry.delete(db); }
  }) };
  registry.set(db, handle); run(); return handle;
}
module.exports = { createReturnReminderWorker, materializeReturnReminders, validateReturnReminder, startWorker, inProcessingWindow, INTERVAL_MS };
