const { randomUUID } = require('node:crypto');
const { localMoment } = require('./agenda');
const { avaliarAcessoAssinatura } = require('./access');
const { createSimulatedDispatcher, isSimulatedDispatcher } = require('./returnReminderDispatcher');

const LEASE_MS = 120000;
const DISPATCH_TIMEOUT_MS = 10000;
const RETRY_MS = 60000;
const MAX_ATTEMPTS = 3;
const INTERVAL_MS = 60000;
const registryKey = Symbol.for('studiofy.returnReminderWorkers.v1');
const registry = globalThis[registryKey] ||= new WeakMap();

function inProcessingWindow(now) {
  const { time } = localMoment(new Date(now));
  return time >= '09:00' && time < '18:00';
}

function createReturnReminderWorker(db, {
  dispatcher = createSimulatedDispatcher(), schema = process.env.DATABASE_SCHEMA || 'salaoflix',
  clock, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS,
} = {}) {
  if (!isSimulatedDispatcher(dispatcher)) throw new Error('Only a local simulated dispatcher is allowed');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid return schema');
  if (!Number.isInteger(dispatchTimeoutMs) || dispatchTimeoutMs < 1 || dispatchTimeoutMs > DISPATCH_TIMEOUT_MS) {
    throw new Error('Invalid dispatch timeout');
  }
  // All relation/function names are bound to the installation schema, including
  // when a borrowed connection has temporary relations or a different search_path.
  const s = '"' + schema + '"';
  const table = s + '.return_reminders';
  let stopped = false, active, controller;
  const time = async client => {
    // Preserve PostgreSQL microseconds at exact eligibility/lease boundaries;
    // JavaScript milliseconds are used only for business-zone formatting/math.
    const instant = clock ? clock() : (await client.query('SELECT clock_timestamp()::text AS now')).rows[0].now;
    const milliseconds = +new Date(instant);
    if (!Number.isFinite(milliseconds)) throw new Error('Invalid worker clock');
    return { valueOf: () => milliseconds, toPostgres: () => instant instanceof Date ? instant.toISOString() : instant };
  };
  const transaction = async (client, fn) => {
    await client.query('BEGIN');
    try { const value = await fn(); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  };

  async function processCandidate(candidate) {
    const client = await db.pool.connect();
    let locked = false, broken = false;
    const abort = () => { broken = true; controller?.abort(); };
    client.on('error', abort);
    try {
      await client.query("SET statement_timeout = '5s'");
      // Migration 016's opportunity trigger also resolves source row types.
      // A controlled path protects those lookups, with pg_temp explicitly last.
      await client.query(`SET search_path TO pg_catalog,${s},pg_temp`);
      // No reminder/appointment/global lock is held while trying this lock.
      const group = [candidate.assinatura_id, candidate.customer_key, candidate.service_identity];
      const key = (await client.query(`SELECT ${s}.studiofy_return_group_key($1,$2,$3)::text AS key`, group)).rows[0].key;
      locked = (await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key])).rows[0].locked;
      if (!locked || stopped) return 'skipped';
      const claim = await transaction(client, async () => {
        await client.query(`SELECT ${s}.studiofy_return_supersede_group($1,$2,$3)`, group);
        const row = (await client.query(`SELECT * FROM ${table} WHERE id=$1 AND assinatura_id=$2 FOR UPDATE`, [candidate.id, candidate.assinatura_id])).rows[0];
        if (!row || !['pending', 'processing'].includes(row.status)) return;
        const now = await time(client);
        if (row.status === 'processing') {
          // A missing lease cannot establish abandonment. Fail closed.
          if (!row.lease_until || row.lease_until > now) return;
          if (row.dispatch_started_at) {
            await client.query(`UPDATE ${table} SET status='uncertain',reason_code='delivery_uncertain',
              claim_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1`, [row.id, now]);
            return { recovered: 'uncertain' };
          }
        }
        if (row.eligible_at > now || row.next_attempt_at > now || !inProcessingWindow(now)) return;
        if (row.attempts >= MAX_ATTEMPTS) {
          await client.query(`UPDATE ${table} SET status='failed',reason_code='provider_rejected',
            claim_token=NULL,lease_until=NULL,updated_at=$2 WHERE id=$1`, [row.id, now]);
          return { recovered: 'failed' };
        }
        return (await client.query(`UPDATE ${table} SET status='processing',claim_token=$2,claimed_at=$3,
          lease_until=$4,attempts=attempts+1,reason_code=NULL,updated_at=$3
          WHERE id=$1 RETURNING *`, [row.id, randomUUID(), now, new Date(+now + LEASE_MS)])).rows[0];
      });
      if (!claim) return 'skipped';
      if (claim.recovered) return claim.recovered;

      const owned = async now => (await client.query(`SELECT * FROM ${table}
        WHERE id=$1 AND assinatura_id=$2 AND status='processing' AND claim_token=$3 AND lease_until>$4 FOR UPDATE`,
      [claim.id, claim.assinatura_id, claim.claim_token, now])).rows[0];
      const finish = async (status, reason, resultId = null) => transaction(client, async () => {
        const now = await time(client);
        if (!await owned(now)) return 'lost_claim';
        await client.query(`UPDATE ${table} SET status=$2,reason_code=$3,claim_token=NULL,lease_until=NULL,
          provider_message_id=$4,sent_at=CASE WHEN $2='sent' THEN $5::timestamptz ELSE NULL END,updated_at=$5
          WHERE id=$1 AND status='processing' AND claim_token=$6 AND lease_until>$5`,
        [claim.id, status, reason, resultId, now, claim.claim_token]);
        return status;
      });
      const retry = async () => transaction(client, async () => {
        const now = await time(client), row = await owned(now);
        if (!row || row.dispatch_started_at) return 'lost_claim';
        const exhausted = row.attempts >= MAX_ATTEMPTS;
        await client.query(`UPDATE ${table} SET status=$2,reason_code=$3,claim_token=NULL,lease_until=NULL,
          next_attempt_at=$4,updated_at=$5 WHERE id=$1 AND claim_token=$6 AND lease_until>$5`,
        [claim.id, exhausted ? 'failed' : 'pending', exhausted ? 'provider_rejected' : null,
          new Date(+now + RETRY_MS), now, claim.claim_token]);
        return exhausted ? 'failed' : 'retry';
      });

      let message;
      try { message = dispatcher.prepare(claim); }
      catch { return await retry(); }
      if (stopped) return await retry();

      // Commit intent before dispatch, retaining the *session* lock across both
      // transactions and the local dispatch. Do not lock Agenda/appointments here.
      const intent = await transaction(client, async () => {
        const now = await time(client), row = await owned(now);
        if (!row || row.dispatch_started_at) return 'lost_claim';
        if (!inProcessingWindow(now) || row.eligible_at > now) return 'window_closed';
        const account = (await client.query(`SELECT * FROM ${s}.assinaturas WHERE id=$1`, [row.assinatura_id])).rows[0];
        const service = (await client.query(`SELECT id,ativo FROM ${s}.servicos_assinatura
          WHERE id=$1 AND assinatura_id=$2`, [row.service_identity.slice(8), row.assinatura_id])).rows[0];
        const reason = !account || !avaliarAcessoAssinatura(account, +now).liberado ? 'account_unavailable' :
          !service || !service.ativo ? 'unavailable_service' : null;
        if (reason) {
          await client.query(`UPDATE ${table} SET status='cancelled',reason_code=$2,claim_token=NULL,
            lease_until=NULL,updated_at=$3 WHERE id=$1`, [row.id, reason, now]);
          return 'cancelled';
        }
        await client.query(`UPDATE ${table} SET dispatch_started_at=$2,updated_at=$2 WHERE id=$1
          AND status='processing' AND claim_token=$3 AND lease_until>$2`, [row.id, now, row.claim_token]);
        return 'ready';
      });
      if (intent === 'window_closed') return await retry();
      if (intent !== 'ready') return intent;

      controller = new AbortController();
      let timeout;
      try {
        if (stopped || broken) controller.abort();
        const result = await Promise.race([
          dispatcher.dispatch(message, { signal: controller.signal }),
          new Promise((_, reject) => { timeout = setTimeout(() => {
            controller.abort(); reject(new Error('Simulated dispatch timeout'));
          }, dispatchTimeoutMs); }),
        ]);
        if (result.status === 'sent' && /^simulated:[a-f0-9-]+$/.test(result.id)) return await finish('sent', null, result.id);
        if (result.status === 'rejected') return await finish('failed', 'provider_rejected');
        return await finish('uncertain', 'delivery_uncertain');
      } catch {
        // A failed/ambiguous COMMIT also follows this path. No new dispatch occurs.
        if (broken) return 'lost_claim';
        return await finish('uncertain', 'delivery_uncertain');
      } finally { clearTimeout(timeout); controller.abort(); controller = undefined; }
    } finally {
      client.removeListener('error', abort);
      // Destroy rather than pool a session holding an advisory lock. This also
      // handles rollback/unlock failures and connection loss without leaking locks.
      client.release(true);
    }
  }

  async function run() {
    await db.ready;
    const results = [];
    // Bounded scans avoid monopolizing a server pool or spinning on active groups.
    const candidates = await db.pool.query(`SELECT id,assinatura_id,customer_key,service_identity FROM ${table}
      WHERE (status='pending' AND eligible_at<=COALESCE($1::timestamptz,clock_timestamp())
        AND next_attempt_at<=COALESCE($1::timestamptz,clock_timestamp()))
        OR (status='processing' AND lease_until<=COALESCE($1::timestamptz,clock_timestamp()))
      ORDER BY next_attempt_at,id LIMIT 50`, [clock ? clock() : null]);
    for (const row of candidates.rows) {
      if (stopped) break;
      results.push(await processCandidate(row));
    }
    return results;
  }
  function drain() {
    if (stopped) return Promise.resolve([]);
    if (!active) active = run().finally(() => { active = undefined; });
    return active;
  }
  async function stop() { stopped = true; controller?.abort(); await active; }
  return { drain, stop };
}

function startWorker(db, options = {}) {
  if (registry.has(db)) return registry.get(db);
  const worker = createReturnReminderWorker(db, options);
  const run = () => worker.drain().catch(() => console.error('[Studiofy] Falha no worker de retorno simulado.'));
  const timer = setInterval(run, INTERVAL_MS); timer.unref();
  const handle = { stop: async () => { clearInterval(timer); try { await worker.stop(); } finally { registry.delete(db); } } };
  registry.set(db, handle);
  void run();
  return handle;
}

module.exports = { createReturnReminderWorker, startWorker, inProcessingWindow, LEASE_MS, DISPATCH_TIMEOUT_MS, RETRY_MS, MAX_ATTEMPTS, INTERVAL_MS };
