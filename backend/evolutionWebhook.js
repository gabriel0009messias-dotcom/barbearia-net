const crypto = require('crypto');
const { transaction } = require('./services/whatsapp/sessionRepository');
const { createScheduling } = require('./services/whatsapp/scheduling');
const { enviarTextoInstancia } = require('./evolutionApi');
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
  return { instance, phone: remote.split('@')[0], messageId: key.id, text: text.trim() };
}

const log = (event, data = {}) => console.info('[WhatsApp]', JSON.stringify(sanitize({ event, ...data })));

async function drain(send = enviarTextoInstancia) {
  // Persistent lease prevents multiple processes from sending the same response concurrently.
  for (let i = 0; i < 50; i++) {
    const row = await transaction(async db => {
      const pending = await db.getAsync(`SELECT m.* FROM whatsapp_messages m
        WHERE m.status = 'pending' AND m.lease_until < $1
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages older WHERE older.instance = m.instance
          AND older.phone = m.phone AND older.status = 'pending' AND older.id < m.id)
        ORDER BY m.id LIMIT 1`, [Date.now()]);
      if (pending) await db.runAsync("UPDATE whatsapp_messages SET lease_until = $1 WHERE id = $2", [Date.now() + 120000, pending.id]);
      return pending;
    });
    if (!row) return;
    try {
      const account = await transaction(db => db.getAsync('SELECT * FROM assinaturas WHERE id=$1', [row.assinatura_id]));
      if (!require('./services/access').avaliarAcessoAssinatura(account).liberado) {
        // Access deferral is not a provider attempt and must not grow transport backoff.
        await transaction(db => db.runAsync('UPDATE whatsapp_messages SET lease_until=$1 WHERE id=$2', [Date.now() + 300000, row.id]));
        continue;
      }
      await transaction(db => db.runAsync('UPDATE whatsapp_messages SET attempts=attempts+1 WHERE id=$1', [row.id]));
      await send(row.instance, row.phone, row.response);
      await transaction(db => db.runAsync("UPDATE whatsapp_messages SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = $1", [row.id]));
      log('resposta enviada', { tenant: row.assinatura_id, phone: `***${row.phone.slice(-4)}` });
    } catch {
      log('erro de envio; resposta preservada para nova tentativa', { tenant: row.assinatura_id });
      await transaction(db => db.runAsync("UPDATE whatsapp_messages SET lease_until = $1 WHERE id = $2", [Date.now() + Math.min(300000, 10000 * (row.attempts + 1)), row.id]));
    }
  }
}

async function processarWebhookEvolution(payload = {}, headers = {}, options = {}) {
  if (!authorized(headers)) {
    const error = new Error('Webhook não autorizado.'); error.statusCode = 401; throw error;
  }
  const envelope = extract(payload);
  if (!envelope) return { ok: true, ignored: true };
  const result = await transaction(async db => {
    const tenants = await db.allAsync("SELECT * FROM assinaturas WHERE whatsapp_session = $1 LIMIT 2", [envelope.instance]);
    if (tenants.length !== 1) return { ok: true, ignored: true };
    if (!require('./services/access').avaliarAcessoAssinatura(tenants[0]).liberado) return { ok: true, ignored: true, reason: 'payment_required' };
    const tenant = tenants[0].id;
    if (await db.getAsync("SELECT id FROM whatsapp_messages WHERE instance = $1 AND message_id = $2", [envelope.instance, envelope.messageId])) return { ok: true, duplicate: true };
    const stored = await db.getAsync("SELECT data_json FROM sessoes WHERE assinatura_id = $1 AND telefone = $2", [tenant, envelope.phone]);
    const previous = stored?.data_json ? JSON.parse(stored.data_json) : null;
    const base = String(process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!/^https?:\/\//.test(base)) return { ok: true, ignored: true, reason: 'public_url_missing' };
    await require('./services/studiofy').createStudio(db).ensure(tenant);
    // Send a link on greeting only, leaving ordinary conversation to the establishment.
    if (!/^(oi|ol[aá]|bom dia|boa tarde|boa noite|agendar|agendamento|menu)[!.,\s]*$/i.test(envelope.text)) return { ok: true, ignored: true };
    const result = { session: { state: 'LINK' }, text: `Olá! 👋\nSeja bem-vindo(a) ao ${tenants[0].barbearia_nome}!\n\nPara agendar, veja nossos serviços, preços e horários disponíveis:\n${base}/agendar/${tenants[0].public_slug || 'studio-'+tenant}\n\nQualquer dúvida, estamos à disposição.` };
    await db.runAsync(`INSERT INTO sessoes (assinatura_id, telefone, etapa, nome, data_json) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(assinatura_id, telefone) DO UPDATE SET etapa = excluded.etapa, nome = excluded.nome,
        data_json = excluded.data_json, updated_at = CURRENT_TIMESTAMP`, [tenant, envelope.phone, result.session.state, result.session.name || null, JSON.stringify(result.session)]);
    await db.runAsync("INSERT INTO whatsapp_messages (assinatura_id, instance, phone, message_id, response) VALUES ($1, $2, $3, $4, $5)", [tenant, envelope.instance, envelope.phone, envelope.messageId, result.text]);
    log('mensagem recebida', { instance: envelope.instance, tenant, phone: `***${envelope.phone.slice(-4)}`, state: previous?.state || 'MENU', option: /^\d{1,2}$/.test(envelope.text) ? envelope.text : 'texto', nextState: result.session.state });
    return { ok: true };
  });
  await drain(options.send);
  return result;
}

function startWorker() {
  const run = () => drain().catch(() => log('erro de processamento da fila'));
  void run();
  const timer = setInterval(run, 15000); timer.unref();
  return timer;
}

module.exports = { processarWebhookEvolution, extract, authorized, drain, startWorker };
