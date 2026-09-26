const crypto = require('node:crypto');
const { avaliarAcessoAssinatura } = require('./access');

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(statusCode, message) { throw Object.assign(new Error(message), { statusCode }); }
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) {
    fail(400, 'Campos inválidos.');
  }
}
function text(value, max) {
  if (typeof value !== 'string') fail(400, 'Informe um texto válido.');
  const result = value.trim();
  // Stored/rendered as plain text. Reject markup and non-printing control characters.
  if (!result || result.length > max || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    fail(400, `Texto inválido. Use até ${max} caracteres, sem HTML.`);
  }
  return result;
}
function identity(body) {
  fields(body, ['name', 'phone']);
  const name = text(body.name, 80);
  if (typeof body.phone !== 'string' || body.phone.length > 30 || !/^[+\d\s().-]+$/.test(body.phone)) fail(400, 'Telefone inválido.');
  const phone = body.phone.replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(phone)) fail(400, 'Informe telefone com DDD.');
  return { name, phone };
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'Identificador inválido.');
  return value.toLowerCase();
}
function messageId(value, optional = false) {
  if (optional && value === undefined) return null;
  if (!['string', 'number'].includes(typeof value) || !/^[1-9][0-9]{0,15}$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(400, 'Cursor inválido.');
  return Number(value);
}
const messageColumns = 'id, sender_type, content, client_message_id, created_at, read_at';
const opposite = sender => sender === 'customer' ? 'establishment' : 'customer';

function createChat(db) {
  async function account(c, { slug, tenantId }) {
    const a = slug !== undefined
      ? await c.getAsync("SELECT * FROM assinaturas WHERE COALESCE(public_slug, 'studio-' || id)=$1 FOR SHARE", [slug])
      : await c.getAsync('SELECT * FROM assinaturas WHERE id=$1 FOR SHARE', [tenantId]);
    if (!a) fail(404, 'Chat indisponível.');
    const access = avaliarAcessoAssinatura(a);
    if (!access.liberado) fail(403, 'Chat indisponível para novas operações. O histórico permanece salvo.');
    return a;
  }
  async function find(c, actor, lock = false) {
    const a = await account(c, actor);
    let conversation;
    if (actor.slug !== undefined) {
      if (typeof actor.token !== 'string' || !/^[a-f0-9]{64}$/.test(actor.token)) fail(401, 'Sessão do chat inválida ou expirada.');
      conversation = await c.getAsync(`SELECT * FROM chat_conversations
        WHERE assinatura_id=$1 AND token_hash=$2 AND token_expires_at>clock_timestamp() ${lock ? 'FOR UPDATE' : ''}`, [a.id, hash(actor.token)]);
      if (!conversation) fail(401, 'Sessão do chat inválida ou expirada.');
    } else {
      conversation = await c.getAsync(`SELECT * FROM chat_conversations WHERE assinatura_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`, [a.id, uuid(actor.conversationId)]);
      if (!conversation) fail(404, 'Conversa não encontrada.');
    }
    return conversation;
  }
  async function summary(c, row, sender) {
    const unread = await c.getAsync('SELECT count(*)::int AS count FROM chat_messages WHERE conversation_id=$1 AND sender_type=$2 AND read_at IS NULL', [row.id, opposite(sender)]);
    const shared = { channel: row.channel, status: row.status, name: row.guest_name, createdAt: row.created_at, lastMessageAt: row.last_message_at, unreadCount: unread.count };
    // Guest endpoints never return phone, token/hash or another customer's context.
    return sender === 'customer' ? shared : { ...shared, id: row.id, phone: row.guest_phone, customerContext: null };
  }
  const transaction = callback => db.transaction(callback, { serialize: false });
  async function start(actor, body) {
    const input = identity(body);
    return transaction(async c => {
      const a = await account(c, actor);
      if (actor.token && /^[a-f0-9]{64}$/.test(actor.token)) {
        const existing = await c.getAsync('SELECT * FROM chat_conversations WHERE assinatura_id=$1 AND token_hash=$2 AND token_expires_at>clock_timestamp()', [a.id, hash(actor.token)]);
        if (existing) return { conversation: await summary(c, existing, 'customer'), created: false };
      }
      const token = crypto.randomBytes(32).toString('hex');
      const row = await c.getAsync(`INSERT INTO chat_conversations (id,assinatura_id,guest_name,guest_phone,token_hash,token_expires_at)
        VALUES ($1,$2,$3,$4,$5,clock_timestamp()+interval '30 days') RETURNING *`, [crypto.randomUUID(), a.id, input.name, input.phone, hash(token)]);
      return { conversation: await summary(c, row, 'customer'), token, created: true };
    });
  }
  async function history(actor, sender, query) {
    fields(query, ['before', 'after']);
    const before = messageId(query.before, true), after = messageId(query.after, true);
    if (before && after) fail(400, 'Use somente um cursor.');
    return transaction(async c => {
      const row = await find(c, actor);
      const rows = await c.allAsync(`SELECT ${messageColumns} FROM chat_messages WHERE conversation_id=$1
        AND ($2::bigint IS NULL OR id<$2) AND ($3::bigint IS NULL OR id>$3)
        ORDER BY id ${after ? 'ASC' : 'DESC'} LIMIT 51`, [row.id, before, after]);
      const hasMore = rows.length > 50, page = rows.slice(0, 50);
      if (!after) page.reverse();
      return { conversation: await summary(c, row, sender), messages: page, hasMore,
        oldestId: page[0]?.id || null, newestId: page.at(-1)?.id || null };
    });
  }
  async function send(actor, sender, body) {
    fields(body, ['content', 'clientMessageId']);
    const content = text(body.content, 2000), clientId = uuid(body.clientMessageId);
    return transaction(async c => {
      const row = await find(c, actor, true);
      if (row.status !== 'open') fail(409, 'Esta conversa está encerrada.');
      const prior = await c.getAsync(`SELECT ${messageColumns} FROM chat_messages WHERE conversation_id=$1 AND sender_type=$2 AND client_message_id=$3`, [row.id, sender, clientId]);
      if (prior) {
        if (prior.content !== content) fail(409, 'Identificador de mensagem já utilizado.');
        return { message: prior, created: false };
      }
      // Shared across processes and restarts; the conversation lock prevents quota races.
      const recent = await c.getAsync("SELECT count(*)::int AS count FROM chat_messages WHERE conversation_id=$1 AND sender_type=$2 AND created_at>clock_timestamp()-interval '1 minute'", [row.id, sender]);
      if (recent.count >= 30) fail(429, 'Aguarde um minuto antes de enviar novas mensagens.');
      const message = await c.getAsync(`INSERT INTO chat_messages (conversation_id,sender_type,content,client_message_id)
        VALUES ($1,$2,$3,$4) RETURNING ${messageColumns}`, [row.id, sender, content, clientId]);
      await c.runAsync('UPDATE chat_conversations SET last_message_at=$1 WHERE id=$2', [message.created_at, row.id]);
      return { message, created: true };
    });
  }
  async function read(actor, sender, body) {
    fields(body, ['throughMessageId']);
    const through = messageId(body.throughMessageId);
    return transaction(async c => {
      const row = await find(c, actor, true);
      if (!await c.getAsync('SELECT id FROM chat_messages WHERE conversation_id=$1 AND id=$2', [row.id, through])) fail(400, 'Mensagem não pertence à conversa.');
      await c.runAsync('UPDATE chat_messages SET read_at=clock_timestamp() WHERE conversation_id=$1 AND sender_type=$2 AND id<=$3 AND read_at IS NULL', [row.id, opposite(sender), through]);
      return { conversation: await summary(c, row, sender) };
    });
  }
  async function inbox(tenantId, query, search = '') {
    fields(query, ['cursor']);
    let cursor = null;
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== 'string' || query.cursor.length > 200) throw Error();
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (typeof cursor.id !== 'string' || !UUID.test(cursor.id) || typeof cursor.at !== 'string' || new Date(cursor.at).toISOString() !== cursor.at) throw Error();
      } catch { fail(400, 'Cursor inválido.'); }
    }
    return transaction(async c => {
      await account(c, { tenantId });
      const rows = await c.allAsync(`SELECT c.id,c.channel,c.guest_name AS name,c.guest_phone AS phone,c.status,c.created_at,c.last_message_at,
        (SELECT content FROM chat_messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
        (SELECT count(*)::int FROM chat_messages m WHERE m.conversation_id=c.id AND m.sender_type='customer' AND m.read_at IS NULL) AS unread_count
        FROM chat_conversations c WHERE c.assinatura_id=$1 AND ($2::timestamptz IS NULL OR (c.last_message_at,c.id)<($2,$3::uuid))
        AND ($4='' OR strpos(lower(c.guest_name),lower($4))>0 OR ($5<>'' AND strpos(c.guest_phone,$5)>0))
        ORDER BY c.last_message_at DESC,c.id DESC LIMIT 51`, [tenantId, cursor?.at || null, cursor?.id || null, search, /^[+\d\s().-]+$/.test(search) ? search.replace(/\D/g, '') : '']);
      const conversations = rows.slice(0, 50), last = conversations.at(-1);
      const nextCursor = rows.length > 50 ? Buffer.from(JSON.stringify({ at: last.last_message_at, id: last.id })).toString('base64url') : null;
      return { conversations, nextCursor };
    });
  }
  async function searchInbox(tenantId, body) {
    fields(body, ['query', 'cursor']);
    if (typeof body.query !== 'string' || body.query.length > 80 || /[\x00-\x1f\x7f]/.test(body.query)) fail(400, 'Busca inválida.');
    return inbox(tenantId, body.cursor === undefined ? {} : { cursor: body.cursor }, body.query.trim());
  }
  async function unread(tenantId) {
    return transaction(async c => {
      await account(c, { tenantId });
      return c.getAsync(`SELECT count(*)::int AS messages, count(DISTINCT c.id)::int AS conversations
        FROM chat_conversations c JOIN chat_messages m ON m.conversation_id=c.id
        WHERE c.assinatura_id=$1 AND m.sender_type='customer' AND m.read_at IS NULL`, [tenantId]);
    });
  }
  return { start, history, send, read, inbox, unread, searchInbox };
}
module.exports = { createChat, SESSION_SECONDS };
