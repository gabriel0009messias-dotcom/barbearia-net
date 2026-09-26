const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createChat } = require('../services/chat');

test('Chat Studiofy: API real com PostgreSQL, privacidade e autorização', { timeout: 60000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', PUBLIC_APP_URL: '',
    EVOLUTION_API_URL: 'https://evolution.example.test', EVOLUTION_API_KEY: 'fake-test-key',
    EVOLUTION_API_RETRY_ATTEMPTS: '0', MERCADO_PAGO_ACCESS_TOKEN: 'fake-test-token',
    MERCADO_PAGO_WEBHOOK_SECRET: 'fake-test-secret', MERCADO_PAGO_MODE: 'test' });
  const db = require('../database'); await db.ready;
  const app = express(); app.set('trust proxy', true); app.use(express.json());
  app.get('/browser-test', (_req, res) => res.type('html').send('<!doctype html><title>Chat API test</title>'));
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_APP_URL = base;
  const nativeFetch = global.fetch; let externalCalls = 0;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return nativeFetch(url, options);
    externalCalls++;
    return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '60' } });
  };
  t.after(async () => { global.fetch = nativeFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  const request = async (path, method = 'GET', body, headers = {}) => {
    const response = await nativeFetch(base + '/api' + path, { method, headers: {
      'Content-Type': 'application/json', Origin: base, 'x-studiofy-chat': '1', ...headers,
    }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const accounts = [];
  for (let n = 1; n <= 2; n++) {
    const email = `chat-owner-${n}@example.test`, senha = 'test-password';
    const created = await request('/publico/assinaturas', 'POST', { barbeariaNome: `Chat ${n}`, responsavelNome: 'Pessoa',
      telefone: `1199999800${n}`, email, senha, metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 30 }] });
    assert.equal(created.status, 201);
    const id = created.body.assinatura.id;
    const login = await request('/barbeiro/login', 'POST', { identificador: email, senha });
    const a = await db.getAsync('SELECT public_slug FROM assinaturas WHERE id=$1', [id]);
    accounts.push({ id, slug: a.public_slug || 'studio-' + id, headers: { 'x-barbeiro-token': login.body.token } });
  }
  const [a, b] = accounts;
  const publicPath = (tenant = a) => `/chat/public/${tenant.slug}`;
  const ownerPath = id => `/chat/conversations/${id}`;
  let guest, otherGuest, conversationId, otherId, incoming, reply;
  const payload = content => ({ content, clientMessageId: crypto.randomUUID() });

  await t.test('criação, cookie HttpOnly e somente hash persistido; sem associação por telefone', async () => {
    const response = await request(publicPath() + '/session', 'POST', { name: 'Ana', phone: '(11) 99999-7777' });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.ok(cookie.includes(`Path=/api/chat/public/${a.slug}`));
    guest = { Cookie: cookie.split(';')[0] };
    const token = guest.Cookie.split('=')[1]; assert.match(token, /^[a-f0-9]{64}$/);
    const row = await db.getAsync('SELECT * FROM chat_conversations WHERE assinatura_id=$1', [a.id]);
    conversationId = row.id;
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(row).includes(token), false);
    assert.equal(response.body.conversation.phone, undefined);
    assert.equal(response.body.conversation.id, undefined);
    const inbox = await request('/chat/conversations', 'GET', undefined, a.headers);
    assert.equal(inbox.body.conversations[0].phone, '11999997777');
    const details = await request(ownerPath(conversationId) + '/messages', 'GET', undefined, a.headers);
    assert.equal(details.body.conversation.customerContext, null);
    const again = await request(publicPath() + '/session', 'POST', { name: 'Outro nome', phone: '11999997777' }, guest);
    assert.equal(again.status, 200); assert.equal(again.body.conversation.name, 'Ana');
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations')).n, 1);
  });
  await t.test('cliente envia, estabelecimento responde e ambos recuperam histórico', async () => {
    const sent = await request(publicPath() + '/messages', 'POST', payload('Tem horário amanhã?'), guest);
    assert.equal(sent.status, 201); incoming = sent.body.message;
    assert.equal(incoming.sender_type, 'customer'); assert.equal(incoming.read_at, null);
    const answered = await request(ownerPath(conversationId) + '/messages', 'POST', payload('Olá! Temos às 10h.'), a.headers);
    assert.equal(answered.status, 201); reply = answered.body.message;
    assert.equal(reply.sender_type, 'establishment');
    const history = await request(publicPath() + '/messages', 'GET', undefined, guest);
    assert.equal(history.headers.get('cache-control'), 'no-store');
    assert.deepEqual(history.body.messages.map(m => m.content), ['Tem horário amanhã?', 'Olá! Temos às 10h.']);
    assert.equal(history.body.conversation.unreadCount, 1);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.headers)).body.messages, 1);
  });
  await t.test('leitura não é implícita; confirmação só afeta remetente oposto até o watermark', async () => {
    await request(ownerPath(conversationId) + '/messages', 'GET', undefined, a.headers);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.headers)).body.messages, 1);
    const newer = await request(publicPath() + '/messages', 'POST', payload('E à tarde?'), guest);
    assert.equal((await request(ownerPath(conversationId) + '/read', 'POST', { throughMessageId: incoming.id }, a.headers)).status, 200);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.headers)).body.messages, 1);
    assert.equal((await db.getAsync('SELECT read_at FROM chat_messages WHERE id=$1', [reply.id])).read_at, null);
    await request(publicPath() + '/read', 'POST', { throughMessageId: reply.id }, guest);
    assert.ok((await db.getAsync('SELECT read_at FROM chat_messages WHERE id=$1', [reply.id])).read_at);
    await request(ownerPath(conversationId) + '/read', 'POST', { throughMessageId: newer.body.message.id }, a.headers);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.headers)).body.messages, 0);
  });
  await t.test('clientes diferentes, inclusive mesmo telefone, não compartilham sessão', async () => {
    const second = await request(publicPath() + '/session', 'POST', { name: 'Outra pessoa', phone: '11999997777' });
    assert.equal(second.status, 201); otherGuest = { Cookie: second.headers.get('set-cookie').split(';')[0] };
    const history = await request(publicPath() + '/messages', 'GET', undefined, otherGuest);
    assert.deepEqual(history.body.messages, []);
    const secondRow = await db.getAsync('SELECT id FROM chat_conversations WHERE token_hash=$1', [crypto.createHash('sha256').update(otherGuest.Cookie.split('=')[1]).digest('hex')]);
    otherId = secondRow.id;
    assert.equal((await request(publicPath() + '/messages?conversationId=' + conversationId, 'GET', undefined, otherGuest)).status, 400);
    assert.equal((await request(publicPath() + '/messages', 'POST', { ...payload('invasão'), conversationId }, otherGuest)).status, 400);
    assert.equal((await request(publicPath() + '/read', 'POST', { throughMessageId: incoming.id }, otherGuest)).status, 400);
  });
  await t.test('isolamento de estabelecimentos em histórico, envio, leitura, lista e badge', async () => {
    for (const [suffix, method, body] of [['/messages', 'GET'], ['/messages', 'POST', payload('invasão')], ['/read', 'POST', { throughMessageId: incoming.id }]]) {
      assert.equal((await request(ownerPath(conversationId) + suffix, method, body, b.headers)).status, 404);
    }
    assert.deepEqual((await request('/chat/conversations', 'GET', undefined, b.headers)).body.conversations, []);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, b.headers)).body.messages, 0);
    assert.equal((await request(publicPath(b) + '/messages', 'GET', undefined, guest)).status, 401);
    assert.equal((await request('/chat/conversations?establishment_id=' + a.id, 'GET', undefined, b.headers)).status, 400);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', { ...payload('forjado'), assinatura_id: a.id }, b.headers)).status, 400);
    assert.equal((await request('/chat/conversations', 'GET')).status, 401);
    assert.equal((await request('/chat/conversations/1/messages', 'GET', undefined, a.headers)).status, 400);
  });
  await t.test('tokens ausentes, inválidos, expirados ou duplicados são recusados', async () => {
    for (const headers of [{}, { Cookie: 'studiofy_chat=invalid' }, { Cookie: 'studiofy_chat=' + 'a'.repeat(64) }, { Cookie: guest.Cookie + '; ' + otherGuest.Cookie }]) {
      assert.equal((await request(publicPath() + '/messages', 'GET', undefined, headers)).status, 401);
    }
    await db.runAsync("UPDATE chat_conversations SET token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [otherId]);
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, otherGuest)).status, 401);
    assert.ok(await db.getAsync('SELECT id FROM chat_conversations WHERE id=$1', [otherId]));
  });
  await t.test('CSRF: origem externa, origem ausente, formulário e cabeçalho ausente recusados', async () => {
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'x-studiofy-chat': '' }, { 'sec-fetch-site': 'cross-site' }, { 'Content-Type': 'text/plain' }]) {
      assert.equal((await request(publicPath() + '/messages', 'POST', payload('CSRF'), { ...guest, ...headers })).status, 403);
    }
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, { ...guest, Origin: 'https://evil.example' })).status, 403);
  });
  await t.test('XSS, objetos, controles, texto vazio e mensagens grandes são rejeitados', async () => {
    const before = (await db.getAsync('SELECT count(*)::int AS n FROM chat_messages')).n;
    for (const content of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '', '   ', 'x'.repeat(2001), '\u0000', { html: 'x' }]) {
      assert.equal((await request(publicPath() + '/messages', 'POST', payload(content), guest)).status, 400);
    }
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('<svg onload=alert(1)>'), a.headers)).status, 400);
    assert.equal((await request(publicPath() + '/session', 'POST', { name: '<script>', phone: '11999997777' })).status, 400);
    assert.equal((await request(publicPath() + '/session', 'POST', { name: 'Ana', phone: 'abc11999997777' })).status, 400);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_messages')).n, before);
  });
  await t.test('retries concorrentes são idempotentes e não duplicam não lidas', async () => {
    const body = payload('Mensagem com retry');
    const responses = await Promise.all([request(ownerPath(conversationId) + '/messages', 'POST', body, a.headers), request(ownerPath(conversationId) + '/messages', 'POST', body, a.headers)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
    assert.equal(responses[0].body.message.id, responses[1].body.message.id);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', { ...body, content: 'outro texto' }, a.headers)).status, 409);
  });
  await t.test('texto de 2000 caracteres e Unicode são aceitos; remetente/data não vêm do cliente', async () => {
    const sent = await request(ownerPath(conversationId) + '/messages', 'POST', payload('a'.repeat(2000)), a.headers);
    assert.equal(sent.status, 201); assert.equal(sent.body.message.content.length, 2000);
    assert.ok(Number.isFinite(Date.parse(sent.body.message.created_at)));
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('Olá! 👋\nAté amanhã.'), a.headers)).status, 201);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', { ...payload('forjado'), sender_type: 'customer', created_at: '2099-01-01' }, a.headers)).status, 400);
    assert.equal((await request(ownerPath(conversationId) + '/read', 'POST', { throughMessageId: [incoming.id] }, a.headers)).status, 400);
  });
  await t.test('histórico paginado completo, cursor incremental e limites de leitura', async () => {
    for (let i = 0; i < 105; i++) await db.runAsync('INSERT INTO chat_messages (conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [otherId, 'customer', `Histórico ${i}`, crypto.randomUUID()]);
    const all = []; let before;
    do {
      const result = await request(ownerPath(otherId) + '/messages' + (before ? '?before=' + before : ''), 'GET', undefined, a.headers);
      assert.equal(result.status, 200); assert.ok(result.body.messages.length <= 50);
      all.unshift(...result.body.messages); before = result.body.hasMore ? result.body.oldestId : null;
    } while (before);
    assert.equal(all.length, 105); assert.equal(new Set(all.map(m => m.id)).size, 105);
    const delta = await request(ownerPath(otherId) + '/messages?after=' + all[99].id, 'GET', undefined, a.headers);
    assert.deepEqual(delta.body.messages.map(m => m.id), all.slice(100).map(m => m.id));
    assert.equal((await request(ownerPath(otherId) + '/messages?after=1&before=2', 'GET', undefined, a.headers)).status, 400);
    assert.equal((await request(ownerPath(otherId) + '/messages?after=abc', 'GET', undefined, a.headers)).status, 400);
  });
  await t.test('limite de criação por IP não aceita X-Forwarded-For prefixado para evasão', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await request(publicPath() + '/session', 'POST', { name: 'Teste limite', phone: '11999997777' }, { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` })).status, 201);
    const response = await request(publicPath() + '/session', 'POST', { name: 'Teste limite', phone: '11999997777' }, { 'x-forwarded-for': '198.51.100.99, 203.0.113.9' });
    assert.equal(response.status, 429); assert.ok(response.headers.get('retry-after'));
  });
  await t.test('limite de envio por IP e quota persistente por conversa', async () => {
    let limited;
    for (let i = 0; i < 31; i++) { limited = await request(publicPath() + '/messages', 'POST', payload('Limite'), { ...guest, 'x-forwarded-for': '203.0.113.20' }); if (limited.status === 429) break; }
    assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
    const service = createChat(db);
    await assert.rejects(service.send({ tenantId: a.id, conversationId: otherId }, 'customer', payload('Limite persistente')), e => e.statusCode === 429);
  });
  await t.test('trial expirado bloqueia todas as operações sem apagar mensagens; pagamento continua acessível', async () => {
    const before = await db.allAsync('SELECT * FROM chat_messages ORDER BY id');
    await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01T00:00:00.000Z',trial_ends_at='2000-01-08T00:00:00.000Z' WHERE id=$1", [a.id]);
    assert.equal((await request('/chat/conversations', 'GET', undefined, a.headers)).status, 403);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.headers)).status, 403);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('expirado'), a.headers)).status, 403);
    assert.equal((await request(ownerPath(conversationId) + '/read', 'POST', { throughMessageId: incoming.id }, a.headers)).status, 403);
    const h = { ...guest, 'x-forwarded-for': '203.0.113.30' };
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, h)).status, 403);
    assert.equal((await request(publicPath() + '/messages', 'POST', payload('expirado'), h)).status, 403);
    assert.equal((await request(publicPath() + '/read', 'POST', { throughMessageId: reply.id }, h)).status, 403);
    assert.equal((await request(publicPath() + '/session', 'POST', { name: 'Teste', phone: '11999997777' }, h)).status, 403);
    assert.equal((await request('/barbeiro/me', 'GET', undefined, a.headers)).status, 200);
    assert.equal((await request('/publico/assinatura-config')).status, 200);
    assert.deepEqual(await db.allAsync('SELECT * FROM chat_messages ORDER BY id'), before);
  });
  await t.test('assinatura ativa libera a mesma sessão e preserva mensagens', async () => {
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1", [a.id]);
    assert.equal((await request('/chat/conversations', 'GET', undefined, a.headers)).status, 200);
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, guest)).status, 200);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('Assinatura ativa'), a.headers)).status, 201);
  });
  await t.test('Evolution 429 não afeta leitura nem resposta do Chat Studiofy', async () => {
    assert.equal(externalCalls, 0, 'Chat não deve chamar provedores externos');
    await db.runAsync('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', ['chat-independence-test', a.id]);
    const whatsapp = await request(`/publico/assinaturas/${a.id}/whatsapp/status`, 'GET', undefined, a.headers);
    assert.equal(whatsapp.status, 429); assert.ok(externalCalls > 0);
    const before = externalCalls;
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, guest)).status, 200);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('Canal independente'), a.headers)).status, 201);
    assert.equal(externalCalls, before);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM whatsapp_messages')).n, 0);
  });
  await t.test('sem configuração ou conexão WhatsApp, chat continua disponível', async () => {
    const before = externalCalls;
    process.env.EVOLUTION_API_URL = ''; process.env.EVOLUTION_API_KEY = '';
    await db.runAsync("UPDATE assinaturas SET whatsapp_session=NULL,whatsapp_status='nao_configurado' WHERE id=$1", [a.id]);
    assert.equal((await request(publicPath() + '/messages', 'GET', undefined, guest)).status, 200);
    assert.equal((await request(ownerPath(conversationId) + '/messages', 'POST', payload('Sem WhatsApp'), a.headers)).status, 201);
    assert.equal(externalCalls, before);
  });
  await t.test('cookie real no navegador não fica acessível ao JavaScript e retoma histórico', async () => {
    const puppeteer = require('puppeteer'), fs = require('node:fs');
    const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
    assert.ok(executablePath, 'Chrome necessário para validar cookie real');
    const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage(); await page.goto(base + '/browser-test');
      const result = await page.evaluate(async path => {
        const created = await fetch(path + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-studiofy-chat': '1', 'x-forwarded-for': '203.0.113.77' }, body: JSON.stringify({ name: 'Navegador', phone: '11999996666' }) });
        const history = await fetch(path + '/messages');
        return { created: created.status, history: history.status, cookie: document.cookie, body: await created.json() };
      }, '/api' + publicPath());
      assert.equal(result.created, 201); assert.equal(result.history, 200); assert.equal(result.cookie, '');
      assert.equal(result.body.token, undefined);
      await page.reload();
      assert.equal(await page.evaluate(async path => (await fetch(path + '/messages')).status, '/api' + publicPath()), 200);
      const cookies = await page.cookies(base + '/api' + publicPath());
      assert.equal(cookies.find(c => c.name === 'studiofy_chat').httpOnly, true);
    } finally { await browser.close(); }
  });
  await t.test('produção usa cookie Secure sem Domain, mesmo atrás de terminação TLS', async () => {
    process.env.RENDER = 'true';
    const secureApp = express(); secureApp.use(express.json());
    secureApp.use('/api/chat', require('../chatRoutes')(db, (_req, res) => res.sendStatus(401)));
    process.env.RENDER = 'false';
    const secureServer = secureApp.listen(0, '127.0.0.1'); await new Promise(r => secureServer.once('listening', r));
    try {
      const response = await nativeFetch(`http://127.0.0.1:${secureServer.address().port}/api${publicPath()}/session`, {
        method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'x-studiofy-chat': '1' },
        body: JSON.stringify({ name: 'Cookie seguro', phone: '11999996666' }),
      });
      assert.equal(response.status, 201);
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^__Secure-studiofy_chat=/); assert.match(cookie, /; Secure/);
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/i);
    } finally { secureServer.closeAllConnections(); await new Promise(r => secureServer.close(r)); }
  });
  await t.test('caixa de entrada paginada limita resposta e não inclui outra conta', async () => {
    const service = createChat(db);
    for (let i = 0; i < 52; i++) await service.start({ slug: b.slug }, { name: 'Cliente de B', phone: '11999996666' });
    // Same timestamp exercises UUID tie-breaking, including millisecond round-tripping.
    await db.runAsync("UPDATE chat_conversations SET last_message_at='2026-09-25T12:00:00.123Z' WHERE assinatura_id=$1", [b.id]);
    const first = await request('/chat/conversations', 'GET', undefined, b.headers);
    assert.equal(first.body.conversations.length, 50); assert.ok(first.body.nextCursor);
    const second = await request('/chat/conversations?cursor=' + first.body.nextCursor, 'GET', undefined, b.headers);
    assert.equal(second.body.conversations.length, 2); assert.equal(second.body.nextCursor, null);
    const ids = [...first.body.conversations, ...second.body.conversations].map(c => c.id);
    assert.equal(new Set(ids).size, 52); assert.ok(!ids.includes(conversationId));
    assert.equal((await request('/chat/conversations?cursor=garbage', 'GET', undefined, b.headers)).status, 400);
    const invalid = Buffer.from(JSON.stringify({ id: ids[0], at: '1' })).toString('base64url');
    assert.equal((await request('/chat/conversations?cursor=' + invalid, 'GET', undefined, b.headers)).status, 400);
  });
  await t.test('exclusão explícita de conta remove somente seu chat por FK; outras contas preservadas', async () => {
    const service = createChat(db), current = await db.allAsync('SELECT * FROM chat_messages ORDER BY id');
    const target = await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1 LIMIT 1', [b.id]);
    await service.send({ tenantId: b.id, conversationId: target.id }, 'establishment', payload('Remoção isolada'));
    await db.transaction(async c => {
      // Same explicit account deletion supported by the project, only on this test fixture.
      await c.runAsync('DELETE FROM servicos_assinatura WHERE assinatura_id=$1', [b.id]);
      await c.runAsync('DELETE FROM assinaturas WHERE id=$1', [b.id]);
    });
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations WHERE assinatura_id=$1', [b.id])).n, 0);
    assert.deepEqual(await db.allAsync('SELECT * FROM chat_messages ORDER BY id'), current);
    assert.ok(await db.getAsync('SELECT id FROM chat_conversations WHERE id=$1', [conversationId]));
  });
});
