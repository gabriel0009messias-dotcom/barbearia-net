const crypto = require('crypto');
const { transaction } = require('./services/whatsapp/sessionRepository');
const { enviarTextoInstancia, receberEventoConexao, extrairEstadoInstancia } = require('./evolutionApi');
const { sanitize } = require('./evolutionLog');

function authorized(headers) {
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  const received = headers['x-webhook-secret'];
  return Boolean(expected && typeof received === 'string' &&
    Buffer.byteLength(expected) === Buffer.byteLength(received) &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received)));
}

function extract(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const event = String(payload.event || '').toUpperCase().replace(/[.\-]/g, '_');
  if (event !== 'MESSAGES_UPSERT') return null;
  const data = payload.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const key = data.key || {};
  if (![false, 'false'].includes(key.fromMe) || data.fromMe === true) return null;
  // LIDs are opaque identifiers, never telephone numbers. Use the alternate PN when provided.
  const jid = String(key.remoteJid || '');
  if (/@(g\.us|broadcast|newsletter)$/.test(jid)) return null;
  const remote = jid.endsWith('@lid') ? String(key.remoteJidAlt || data.remoteJidAlt || '') : jid;
  if (!/^\d{10,15}@(s\.whatsapp\.net|c\.us)$/.test(remote)) return null;
  let message = data.message || {};
  for (let i = 0; i < 3; i++) message = message.ephemeralMessage?.message || message.viewOnceMessage?.message || message;
  const text = message.conversation || message.extendedTextMessage?.text ||
    message.buttonsResponseMessage?.selectedButtonId || message.listResponseMessage?.singleSelectReply?.selectedRowId;
  const instance = payload.instance || payload.instanceName;
  if (typeof text !== 'string' || !text.trim() || text.length > 2000 || typeof key.id !== 'string' || !key.id || key.id.length > 200 || typeof instance !== 'string' || !instance || instance.length > 150) return null;
  const context = message.extendedTextMessage?.contextInfo || message.messageContextInfo || {};
  const quoted = context.quotedMessage;
  const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
  const reference = typeof quotedText === 'string' ? quotedText.match(/Referência: ([a-f0-9]{16})\b/)?.[1] : undefined;
  const rawTimestamp = Number(data.messageTimestamp);
  const timestamp = Number.isSafeInteger(rawTimestamp) && rawTimestamp > 0 ? rawTimestamp : undefined;
  const replyTo = typeof context.stanzaId === 'string' && context.stanzaId.length > 0 && context.stanzaId.length <= 200 ? context.stanzaId : undefined;
  return { instance, phone: remote.split('@')[0], messageId: key.id, text: text.trim(), reference, timestamp,
    replyTo, quotedText: typeof quotedText === 'string' && quotedText ? quotedText : undefined,
    hasReplyContext: Boolean(quoted || context.stanzaId) };
}

const log = (event, data = {}) => console.info('[WhatsApp]', JSON.stringify(sanitize({ event, ...data })));

const connectionEvents = new Map();
const connectionEventJobs = new Map();
async function processConnectionEvent(payload) {
  const event = String(payload.event || '').toUpperCase().replace(/[.\-]/g, '_');
  if (!['CONNECTION_UPDATE', 'QRCODE_UPDATED'].includes(event)) return null;
  const instance = payload.instance || payload.instanceName;
  if (typeof instance !== 'string' || !instance || instance.length > 150) return { ok: true, ignored: true };
  const state = extrairEstadoInstancia(payload.data);
  if (event === 'CONNECTION_UPDATE' && !state) return { ok: true, ignored: true };
  const digest = crypto.createHash('sha256').update(JSON.stringify([event, instance, payload.data])).digest('hex');
  const eventKey = `${instance}|${event}`;
  for (const [key, entry] of connectionEvents) if (entry.until <= Date.now()) connectionEvents.delete(key);
  const previous = connectionEventJobs.get(instance) || Promise.resolve();
  const job = previous.catch(() => {}).then(async () => {
    const result = await transaction(async db => {
    const tenants = await db.allAsync('SELECT id FROM assinaturas WHERE whatsapp_session = $1 LIMIT 2', [instance]);
    if (tenants.length !== 1) return { ok: true, ignored: true };
    if (connectionEvents.get(eventKey)?.digest === digest) return { ok: true, duplicate: true };
    if (event === 'CONNECTION_UPDATE') {
      const status = ['open', 'connected'].includes(state) ? 'conectado' : ['connecting', 'pairing', 'syncing'].includes(state) ? 'iniciando' : 'desconectado';
      await db.runAsync('UPDATE assinaturas SET whatsapp_status=$1, whatsapp_ultimo_check_em=$2, whatsapp_ultimo_erro=NULL WHERE id=$3 AND whatsapp_session=$4',
        [status, new Date().toISOString(), tenants[0].id, instance]);
    }
    return { ok: true };
    });
    // Publish in-memory state only after the database commit succeeds.
    if (!result.ignored && !result.duplicate) {
      receberEventoConexao(instance, event, payload.data);
      log('evento de conexao recebido', { instance, event, state,
        hasQr: Boolean(payload.data?.qrcode?.base64 || payload.data?.base64 || payload.data?.qrcode?.code),
        hasPairingCode: Boolean(payload.data?.qrcode?.pairingCode || payload.data?.pairingCode) });
      if (connectionEvents.size >= 1000) connectionEvents.delete(connectionEvents.keys().next().value);
      connectionEvents.set(eventKey, { digest, until: Date.now() + 60000 });
    }
    return result;
  });
  connectionEventJobs.set(instance, job);
  return job.finally(() => { if (connectionEventJobs.get(instance) === job) connectionEventJobs.delete(instance); });
}

async function drain(send = enviarTextoInstancia) {
  const db = require('./database');
  const { createEvolutionDelivery, newDeliveryClaim } = require('./services/evolutionDelivery');
  const delivery = createEvolutionDelivery(db);
  const { materializeBookingConfirmations, validateBookingConfirmation } = require('./services/bookingConfirmation');
  const { validateConversationResponse, createConversationProcessor } = require('./services/whatsapp/conversationStore');
  const conversations = createConversationProcessor(db);
  // Producer recovery is independent of dispatch: a transient materialization
  // failure keeps its durable origin and must not stop the existing outbox.
  try { await materializeBookingConfirmations(db); }
  catch { log('erro ao preparar confirmações de agendamento'); }
  await delivery.recoverInterrupted('whatsapp_messages');
  for (let i = 0; i < 50; i++) {
    // Durable input recovery runs before looking for the next outbox message,
    // including after a restart or explicit reconciliation of uncertain delivery.
    await conversations.consumePending();
    try { await materializeBookingConfirmations(db); }
    catch { log('erro ao preparar confirmações de agendamento'); }
    const row = await db.transaction(async client => {
      const pending = await client.getAsync(`SELECT m.* FROM whatsapp_messages m
        WHERE m.status='pending' AND m.lease_until<$1 AND m.dispatch_started_at IS NULL
          AND (m.attempts=0 OR m.claim_token IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM whatsapp_messages older WHERE older.instance=m.instance
          AND older.phone=m.phone AND older.status IN ('pending','sending','uncertain') AND older.id<m.id)
        ORDER BY m.id LIMIT 1 FOR UPDATE OF m SKIP LOCKED`, [Date.now()]);
      if (!pending) return null;
      const claim = newDeliveryClaim();
      await client.runAsync("UPDATE whatsapp_messages SET status='sending',claim_token=$1,operation_token=NULL,dispatch_started_at=NULL,claimed_at=CURRENT_TIMESTAMP WHERE id=$2",[claim,pending.id]);
      return { ...pending, claim_token: claim };
    }, { serialize: false });
    if (!row) return;
    const account = await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[row.assinatura_id]);
    if (!require('./services/access').avaliarAcessoAssinatura(account).liberado) {
      await db.runAsync("UPDATE whatsapp_messages SET status='pending',lease_until=$1 WHERE id=$2 AND claim_token=$3 AND status='sending'",[Date.now()+300000,row.id,row.claim_token]);
      continue;
    }
    const sendWithContext = async (...args) => {
      const result = await send(...args);
      // Store provider correlation before finalizing acceptance. A failure here
      // remains uncertain under the existing delivery protocol; never resend.
      if (row.conversation_managed && require('./evolutionApi').acceptedEvolutionMessage(result)) {
        const providerId = result.key?.id;
        if (typeof providerId === 'string' && providerId.length > 0 && providerId.length <= 200)
          await db.runAsync('UPDATE whatsapp_conversation_responses SET provider_message_id=$1 WHERE delivery_id=$2 AND assinatura_id=$3',[providerId,row.id,row.assinatura_id]);
      }
      return result;
    };
    await delivery.dispatch('whatsapp_messages',row,sendWithContext, { validate: async () =>
      await validateConversationResponse(db,row) && (!row.booking_confirmation_appointment_id || await validateBookingConfirmation(db,row)) });
  }
}

async function processarWebhookEvolution(payload = {}, headers = {}, options = {}) {
  if (!authorized(headers)) {
    const error = new Error('Webhook não autorizado.'); error.statusCode = 401; throw error;
  }
  const connectionEvent = await processConnectionEvent(payload);
  if (connectionEvent) return connectionEvent;
  const envelope = extract(payload);
  if (!envelope) return { ok: true, ignored: true };
  const result = await require('./services/whatsapp/conversationStore').createConversationProcessor(require('./database')).process(envelope);
  // HTTP acknowledgements wait only for durable ingestion. The existing worker
  // delivers the outbox, so provider failures cannot delay webhook responses.
  if (!options.deferDelivery) await drain(options.send);
  return result;
}

function startWorker() {
  const run = () => drain().catch(() => log('erro de processamento da fila'));
  void run();
  const timer = setInterval(run, 15000); timer.unref();
  return timer;
}

module.exports = { processarWebhookEvolution, extract, authorized, drain, startWorker };
