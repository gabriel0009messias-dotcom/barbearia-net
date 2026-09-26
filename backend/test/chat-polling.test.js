const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const puppeteer = require('puppeteer');

test('2C.4: fluxo completo com polling, API real e PostgreSQL isolado', { timeout: 150000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', PUBLIC_APP_URL: '', EVOLUTION_API_URL: 'https://evolution.example.test', EVOLUTION_API_KEY: 'fake-key', EVOLUTION_API_RETRY_ATTEMPTS: '0', MERCADO_PAGO_ACCESS_TOKEN: '' });
  const db = require('../database'); await db.ready;
  let fault = null, delayRead = false, releaseRead, activeReads = 0, maxReads = 0;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/chat') && req.path.endsWith('/messages') && req.method === 'GET') {
      activeReads++; maxReads = Math.max(maxReads, activeReads); res.on('finish', () => activeReads--);
      if (fault && req.path.includes(fault.side)) return res.status(fault.status).set('Retry-After', String(fault.retry || 1)).json({ error: 'SQL SECRET stack trace' });
      if (delayRead && req.path.includes('/public/')) { releaseRead = next; return; }
    }
    next();
  });
  app.use('/api', require('../routes')); app.get('/agendar/:slug', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/agendar.html'))); app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_URL = base;
  const nativeFetch = global.fetch; let externalCalls = 0, offline = false;
  global.fetch = async (url, options) => { if (String(url).startsWith(base)) return nativeFetch(url, options); externalCalls++; if (offline) throw Error('offline'); return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); };
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p)); assert.ok(executablePath);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { global.fetch = nativeFetch; releaseRead?.(); await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  const api = async (route, method = 'GET', body, token) => { const response = await nativeFetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token || '' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const accounts = [];
  for (const n of [1, 2]) {
    const signup = await api('/publico/assinaturas', 'POST', { barbeariaNome: 'Studio Sync ' + n, responsavelNome: 'Ana', telefone: '1199999000' + n, email: `sync-${n}@example.test`, senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 40 }] }); assert.equal(signup.status, 201);
    const login = await api('/barbeiro/login', 'POST', { identificador: `sync-${n}@example.test`, senha: 'test-password' }); accounts.push({ id: signup.body.assinatura.id, slug: 'studio-' + signup.body.assinatura.id, token: login.body.token });
  }
  // Separate browser sessions: the public customer must not inherit the owner's localStorage.
  const [a, b] = accounts, client = await (await browser.createBrowserContext()).newPage(), owner = await (await browser.createBrowserContext()).newPage(), errors = [], requests = [];
  for (const [page, side] of [[client, 'client'], [owner, 'owner']]) {
    page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => requests.push({ side, url: r.url(), method: r.method() }));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluateOnNewDocument((side, token) => {
      if (side === 'owner') localStorage.setItem('barbearia_auth_token', token);
      const nativeTimeout = window.setTimeout, nativeClear = window.clearTimeout, realNow = Date.now;
      let offset = 0, id = -1; const timers = new Map();
      Date.now = () => realNow() + offset;
      window.setTimeout = (fn, delay, ...args) => { if (fn.name !== 'tick') return nativeTimeout(fn, delay, ...args); timers.set(--id, { fn, at: Date.now() + delay }); return id; };
      window.clearTimeout = value => { if (value < 0) timers.delete(value); else nativeClear(value); };
      window.advanceChat = async ms => { offset += ms; const due = [...timers].filter(([, value]) => value.at <= Date.now()); for (const [key, value] of due) { timers.delete(key); await value.fn(); } };
      window.chatDelays = () => [...timers.values()].map(t => Math.max(0, t.at - Date.now()));
      window.useRealChatClock = () => {
        const pending = [...timers.values()].map(t => ({ fn: t.fn, delay: Math.max(0, t.at - Date.now()) }));
        timers.clear(); Date.now = realNow; window.setTimeout = nativeTimeout; window.clearTimeout = nativeClear;
        for (const timer of pending) nativeTimeout(timer.fn, timer.delay);
      };
      window.chatHidden = false;
      Object.defineProperty(document, 'hidden', { get: () => window.chatHidden });
      Object.defineProperty(document, 'visibilityState', { get: () => window.chatHidden ? 'hidden' : 'visible' });
      window.setChatHidden = hidden => { window.chatHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
    }, side, a.token);
  }
  const tick = async (page, ms = 8000) => { await page.bringToFront(); return page.evaluate(ms => window.advanceChat(ms), ms); };
  const fill = async (page, selector, value) => { await page.bringToFront(); return page.$eval(selector, (e, value) => { e.value = value; e.dispatchEvent(new Event('input', { bubbles: true })); }, value); };
  const ownerReady = () => owner.waitForFunction(() => document.querySelector('.ci')?.getAttribute('aria-busy') === 'false');
  const clientSend = async text => { await fill(client, '#chatMessage', text); await client.click('#chatSend'); await client.waitForFunction(() => document.querySelector('#chatNotice').textContent === 'Mensagem enviada' && !document.querySelector('#chatSend').disabled); };
  const ownerSend = async text => { await fill(owner, '#inboxReply', text); await owner.click('#inboxSend'); await ownerReady(); assert.match(await owner.$eval('#inboxNotice', e => e.textContent), /Mensagem enviada/); };
  const folder = path.resolve(__dirname, '../../.tmp/chat-polling-preview'); fs.mkdirSync(folder, { recursive: true });
  let conversation, originalTitle;
  const incoming = async (sender, content) => { await db.runAsync("INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '2 minutes')", [conversation, sender, content, crypto.randomUUID()]); await db.runAsync('UPDATE chat_conversations SET last_message_at=clock_timestamp() WHERE id=$1', [conversation]); };

  await t.test('cliente → badge → resposta automática → cliente responde → painel recebe', async () => {
    await owner.goto(base + '/studiofy.html'); await owner.waitForSelector('[data-section="Conversas"]'); await tick(owner, 0); originalTitle = await owner.title();
    await client.bringToFront(); await client.goto(base + '/agendar/' + a.slug); await client.waitForSelector('#chatLauncher'); await client.click('#chatLauncher'); await client.waitForSelector('#chatIdentity', { visible: true });
    await fill(client, '#chatName', 'Maria Santos'); await fill(client, '#chatPhone', '11988887777'); await client.click('#chatStart'); await client.waitForSelector('#chatConversation', { visible: true });
    await clientSend('Olá, tem horário amanhã?'); conversation = (await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1', [a.id])).id;
    await tick(owner, 20000); assert.equal(await owner.$eval('#inboxBadge', e => e.textContent), '1'); assert.equal(await owner.title(), '(1) Studiofy');
    await owner.click('[data-section="Conversas"]'); await ownerReady(); await owner.click(`[data-conversation="${conversation}"]`); await ownerReady(); assert.equal(await owner.title(), originalTitle);
    await ownerSend('Olá! Temos sim.'); await tick(client); assert.match(await client.$eval('#chatMessages', e => e.textContent), /Olá! Temos sim/);
    await clientSend('Ótimo, obrigada!'); await tick(owner); assert.match(await owner.$eval('#inboxMessages', e => e.textContent), /Ótimo, obrigada/); assert.equal(externalCalls, 0);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations WHERE assinatura_id=$1', [a.id])).n, 1);
  });
  await t.test('rascunhos, ordenação, paginação incremental e deduplicação', async () => {
    await fill(client, '#chatMessage', 'Rascunho do cliente'); await fill(owner, '#inboxReply', 'Rascunho do estabelecimento');
    for (let i = 0; i < 65; i++) await incoming(i % 2 ? 'customer' : 'establishment', 'Lote de mensagens ' + i);
    await tick(client); await tick(owner);
    const all = await db.allAsync('SELECT content FROM chat_messages WHERE conversation_id=$1 ORDER BY id', [conversation]);
    assert.deepEqual(await client.$$eval('.sc-message p', es => es.map(e => e.textContent)), all.map(r => r.content));
    assert.deepEqual(await owner.$$eval('.ci-message p', es => es.map(e => e.textContent)), all.map(r => r.content));
    await tick(client); await tick(owner);
    assert.equal(await client.$$eval('.sc-message', es => es.length), all.length); assert.equal(await owner.$$eval('.ci-message', es => es.length), all.length);
    assert.equal(await owner.$$eval('[data-conversation]', es => new Set(es.map(e => e.dataset.conversation)).size === es.length), true);
    assert.equal(await client.$eval('#chatMessage', e => e.value), 'Rascunho do cliente'); assert.equal(await owner.$eval('#inboxReply', e => e.value), 'Rascunho do estabelecimento');
    assert.ok(requests.some(r => r.url.includes('/messages?after=')));
    assert.equal(requests.filter(r => r.url.endsWith('/session') && r.method === 'POST').length, 1);
  });
  await t.test('mensagem fora do final preserva scroll e só marca leitura após visualizar', async () => {
    for (const [page, selector] of [[client, '#chatHistory'], [owner, '#inboxHistory']]) await page.$eval(selector, e => { e.scrollTop = 0; });
    await incoming('establishment', 'Nova resposta fora do final'); await incoming('customer', 'Novo pedido fora do final');
    await tick(client); await tick(owner);
    assert.equal(await client.$eval('#chatHistory', e => e.scrollTop), 0); assert.equal(await owner.$eval('#inboxHistory', e => e.scrollTop), 0);
    assert.equal(await client.$eval('#chatNew', e => e.hidden), false); assert.equal(await owner.$eval('#inboxNew', e => e.hidden), false);
    assert.equal(await client.$eval('#chatNew', e => e.textContent), '↓ Nova mensagem'); assert.equal(await owner.$eval('#inboxNew', e => e.textContent), '↓ Nova mensagem');
    assert.equal((await db.getAsync("SELECT read_at FROM chat_messages WHERE content='Novo pedido fora do final'")).read_at, null);
    assert.equal((await db.getAsync("SELECT read_at FROM chat_messages WHERE content='Nova resposta fora do final'")).read_at, null);
    assert.equal(await owner.title(), '(1) Studiofy');
    await client.screenshot({ path: path.join(folder, 'desktop-cliente-nova-mensagem.png') }); await owner.screenshot({ path: path.join(folder, 'desktop-painel-nova-mensagem.png') });
    await client.bringToFront(); await client.click('#chatNew'); await tick(client, 0); await owner.bringToFront(); await owner.click('#inboxNew'); await tick(owner, 0);
    assert.ok((await db.getAsync("SELECT read_at FROM chat_messages WHERE content='Novo pedido fora do final'")).read_at); assert.equal(await owner.title(), originalTitle);
  });
  await t.test('aba oculta pausa consultas/leitura; retorno recupera as mensagens', async () => {
    await client.evaluate(() => window.setChatHidden(true)); await owner.evaluate(() => window.setChatHidden(true));
    const before = requests.filter(r => r.url.includes('/api/chat')).length; await incoming('customer', 'Recebida com aba oculta'); await incoming('establishment', 'Resposta com aba oculta');
    await tick(client, 60000); await tick(owner, 60000); assert.equal(requests.filter(r => r.url.includes('/api/chat')).length, before);
    assert.equal((await db.getAsync("SELECT read_at FROM chat_messages WHERE content='Recebida com aba oculta'")).read_at, null);
    await client.evaluate(() => window.setChatHidden(false)); await owner.evaluate(() => window.setChatHidden(false)); await tick(client, 0); await tick(owner, 0);
    assert.match(await client.$eval('#chatMessages', e => e.textContent), /Resposta com aba oculta/); assert.match(await owner.$eval('#inboxMessages', e => e.textContent), /Recebida com aba oculta/);
  });
  await t.test('erro, backoff, Retry-After e recuperação preservam mensagens', async () => {
    const before = await client.$$eval('.sc-message p', es => es.map(e => e.textContent));
    fault = { side: '/public/', status: 500 }; await tick(client); assert.equal(await client.$eval('#chatConnection', e => e.hidden), false);
    assert.deepEqual(await client.$$eval('.sc-message p', es => es.map(e => e.textContent)), before);
    const count = requests.length; await tick(client, 8000); assert.equal(requests.length, count);
    await tick(client, 8000); assert.ok((await client.evaluate(() => window.chatDelays()))[0] > 30000);
    fault = { side: '/public/', status: 429, retry: 60 }; await tick(client, 32000); assert.ok((await client.evaluate(() => window.chatDelays()))[0] >= 60000);
    assert.doesNotMatch(await client.$eval('#chatDialog', e => e.textContent), /SQL|SECRET|stack/);
    fault = null; await incoming('establishment', 'Conexão recuperada'); await tick(client, 64000); assert.equal(await client.$eval('#chatConnection', e => e.hidden), true); assert.match(await client.$eval('#chatMessages', e => e.textContent), /Conexão recuperada/);
    fault = { side: '/conversations/', status: 500 }; await tick(owner); assert.equal(await owner.$eval('#inboxConnection', e => e.hidden), false); fault = null; await tick(owner, 16000); assert.equal(await owner.$eval('#inboxConnection', e => e.hidden), true);
  });
  await t.test('request lento não sobrepõe polling, envio ou leitura de aba oculta', async () => {
    delayRead = true; releaseRead = null; maxReads = 0;
    await client.evaluate(() => { window.pendingTick = window.advanceChat(8000); });
    for (let i = 0; i < 50 && !releaseRead; i++) await new Promise(r => setTimeout(r, 10)); assert.ok(releaseRead);
    assert.equal(await client.$eval('#chatMessage', e => e.readOnly), false);
    await tick(client, 24000); assert.equal(maxReads, 1);
    await client.evaluate(() => window.setChatHidden(true)); delayRead = false; releaseRead(); releaseRead = null; await client.evaluate(() => window.pendingTick);
    assert.equal(await client.evaluate(() => window.chatDelays().length), 0); await client.evaluate(() => window.setChatHidden(false)); await tick(client, 0);
  });
  await t.test('isolamento A/B durante polling e privacidade de URL/storage', async () => {
    await require('../services/chat').createChat(db).start({ slug: b.slug }, { name: 'Pessoa privada B', phone: '41955554444' });
    const foreign = (await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1', [b.id])).id;
    await db.runAsync('INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [foreign, 'customer', 'SEGREDO DA CONTA B', crypto.randomUUID()]);
    await tick(owner, 24000); await tick(client);
    assert.doesNotMatch(await owner.$eval('.ci', e => e.textContent), /SEGREDO DA CONTA B|41955554444|Pessoa privada B/);
    assert.equal((await api(`/chat/conversations/${foreign}/messages?after=1`, 'GET', undefined, a.token)).status, 404);
    const cookies = await client.cookies(base + '/api/chat/public/' + a.slug), secret = cookies.find(c => c.name === 'studiofy_chat').value;
    for (const value of [secret, a.token, '11988887777', '41955554444', 'Rascunho']) assert.ok(!requests.some(r => r.url.includes(value)));
    assert.equal(await client.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.doesNotMatch(await owner.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })), /Rascunho|Santos|Lote de mensagens/);
  });
  await t.test('390 e 360: mensagens automáticas com viewport de teclado, sem overflow', async () => {
    for (const width of [390, 360]) {
      for (const [page, history, input] of [[client, '#chatHistory', '#chatMessage'], [owner, '#inboxHistory', '#inboxReply']]) {
        await page.setViewport({ width, height: 800 }); await page.$eval(history, e => { e.scrollTop = e.scrollHeight; }); await page.focus(input);
        await page.setViewport({ width, height: 420 }); await page.waitForFunction(() => Math.abs(visualViewport.height - 420) < 1);
      }
      await incoming('establishment', `Resposta automática ${width}`); await incoming('customer', `Pedido automático ${width}`); await tick(client); await tick(owner);
      assert.match(await client.$eval('#chatMessages', e => e.textContent), new RegExp(`Resposta automática ${width}`));
      assert.match(await owner.$eval('#inboxMessages', e => e.textContent), new RegExp(`Pedido automático ${width}`));
      for (const [page, side, send, input, draft] of [[client, 'cliente', '#chatSend', '#chatMessage', 'Rascunho do cliente'], [owner, 'painel', '#inboxSend', '#inboxReply', 'Rascunho do estabelecimento']]) {
        assert.equal(await page.$eval(input, e => e.value), draft); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.$eval(input, e => document.activeElement === e), true);
        assert.ok(await page.$eval(send, e => { const r = e.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
        await page.screenshot({ path: path.join(folder, `${width}-${side}-teclado-nova.png`) });
        await page.setViewport({ width, height: 800 }); await page.screenshot({ path: path.join(folder, `${width}-${side}-conversa.png`) });
      }
    }
  });
  await t.test('Evolution 429/offline não é consultada pelo polling', async () => {
    assert.equal(externalCalls, 0); assert.equal((await api(`/publico/assinaturas/${a.id}/whatsapp/status`, 'GET', undefined, a.token)).status, 429);
    const before = externalCalls;
    for (const disconnected of [false, true]) {
      offline = disconnected;
      await clientSend('Olá, tem horário amanhã?'); await tick(owner, 24000);
      assert.match(await owner.$eval('#inboxMessages', e => e.textContent), /Olá, tem horário amanhã/);
      await ownerSend('Olá! Temos sim.'); await tick(client, 24000);
      assert.match(await client.$eval('#chatMessages', e => e.textContent), /Olá! Temos sim/);
      await clientSend(disconnected ? 'Recebido com Evolution offline' : 'Recebido com Evolution 429'); await tick(owner);
      assert.match(await owner.$eval('#inboxMessages', e => e.textContent), disconnected ? /Recebido com Evolution offline/ : /Recebido com Evolution 429/);
      assert.equal(externalCalls, before);
    }
    assert.ok(!requests.some(r => /evolution|\/whatsapp\//.test(r.url)));
  });
  await t.test('índices de polling presentes e planos consultados sem migration adicional', async () => {
    const indexes = await db.allAsync('SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename IN ($2,$3)', [env.schema, 'chat_messages', 'chat_conversations']);
    for (const name of ['chat_inbox', 'chat_history', 'chat_unread', 'chat_message_rate']) assert.ok(indexes.some(row => row.indexname === name));
    const plans = [];
    for (const [query, params] of [['SELECT id FROM chat_messages WHERE conversation_id=$1 AND id>$2 ORDER BY id LIMIT 51', [conversation, 1]], ["SELECT count(*) FROM chat_messages WHERE conversation_id=$1 AND sender_type='customer' AND read_at IS NULL", [conversation]], ['SELECT id FROM chat_conversations WHERE assinatura_id=$1 ORDER BY last_message_at DESC,id DESC LIMIT 51', [a.id]]]) plans.push(await db.allAsync('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query, params));
    fs.writeFileSync(path.join(folder, 'query-plans.json'), JSON.stringify(plans, null, 2));
  });
  await t.test('trial expirado interrompe polling operacional e preserva histórico; assinatura restaura', async () => {
    const before = await db.allAsync('SELECT * FROM chat_messages ORDER BY id');
    await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01',trial_ends_at='2000-01-08' WHERE id=$1", [a.id]);
    await tick(client); await tick(owner); await owner.waitForSelector('#subscribe');
    assert.equal(await client.$eval('#chatNotice', e => e.textContent), 'O chat deste estabelecimento está temporariamente indisponível.');
    const count = requests.length; await tick(client, 120000); await tick(owner, 120000); assert.equal(requests.length, count);
    assert.deepEqual(await db.allAsync('SELECT * FROM chat_messages ORDER BY id'), before);
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1", [a.id]);
    await client.bringToFront(); await client.click('#chatClose'); await client.click('#chatLauncher'); await client.waitForSelector('#chatConversation', { visible: true });
    await owner.bringToFront(); await owner.click('#checkAccess'); await owner.waitForSelector('[data-section="Conversas"]'); await ownerReady();
    await clientSend('Assinatura ativa, polling restaurado'); await tick(owner, 24000); assert.match(await owner.$eval('#inboxList', e => e.textContent), /Assinatura ativa/);
    assert.deepEqual(errors, []);
  });
  await t.test('relógio real: badge em 20 s e conversa em 8 s sem atualizar ou recarregar', async () => {
    await client.setViewport({ width: 1440, height: 1000 }); await owner.setViewport({ width: 1440, height: 1000 });
    // Reset fake-clock deadlines before starting the separate wall-clock scenario.
    await client.bringToFront(); await client.reload(); await client.waitForSelector('#chatLauncher');
    await owner.bringToFront(); await owner.reload(); await owner.waitForSelector('[data-section="Conversas"]');
    await client.evaluate(() => window.useRealChatClock()); await owner.evaluate(() => window.useRealChatClock());
    await owner.click('[data-section="Conversas"]'); await ownerReady(); await owner.click(`[data-conversation="${conversation}"]`); await ownerReady();
    assert.equal(await owner.title(), originalTitle);
    await owner.click('[data-section="Dashboard"]');
    await client.bringToFront(); await client.click('#chatLauncher'); await client.waitForSelector('#chatConversation', { visible: true });
    await client.waitForFunction(() => !document.querySelector('#chatSend').disabled);
    const externalBefore = externalCalls;
    await clientSend('Fluxo real: Olá, tem horário amanhã?');
    const sentAt = Date.now();
    await owner.bringToFront();
    await owner.waitForFunction(() => Number(document.querySelector('#inboxBadge')?.textContent) > 0, { timeout: 25000 });
    assert.ok(Date.now() - sentAt >= 18000, 'Badge foi recebido pelo timer real de 20 s');
    const unreadBefore = await owner.$eval('#inboxBadge', e => Number(e.textContent));
    await clientSend('Segunda mensagem entre ciclos do contador'); await owner.bringToFront();
    await owner.waitForFunction(previous => Number(document.querySelector('#inboxBadge')?.textContent) > previous, { timeout: 25000 }, unreadBefore);
    await owner.click('[data-section="Conversas"]'); await ownerReady(); await owner.click(`[data-conversation="${conversation}"]`); await ownerReady();
    assert.match(await owner.$eval('#inboxMessages', e => e.textContent), /Fluxo real: Olá, tem horário amanhã/);
    await ownerSend('Fluxo real: Olá! Temos sim.'); await client.bringToFront();
    await client.waitForFunction(() => document.querySelector('#chatMessages').textContent.includes('Fluxo real: Olá! Temos sim.'), { timeout: 12000 });
    await clientSend('Fluxo real: confirmado'); await owner.bringToFront();
    await owner.waitForFunction(() => document.querySelector('#inboxMessages').textContent.includes('Fluxo real: confirmado'), { timeout: 12000 });
    assert.ok(!requests.some(r => /evolution|\/whatsapp\//.test(r.url)));
    assert.equal(externalCalls, externalBefore);
    assert.deepEqual(errors, []);
  });
  await t.test('quota persistente de envio permanece em 30 mensagens e leitura é independente', async () => {
    const chat = require('../services/chat').createChat(db);
    for (let i = 0; i < 30; i++) await db.runAsync('INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [conversation, 'establishment', 'Quota', crypto.randomUUID()]);
    await assert.rejects(chat.send({ tenantId: a.id, conversationId: conversation }, 'establishment', { content: 'Excedente', clientMessageId: crypto.randomUUID() }), e => e.statusCode === 429);
    assert.equal((await api('/chat/conversations/' + conversation + '/messages?after=1', 'GET', undefined, a.token)).status, 200);
  });
});
