const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const puppeteer = require('puppeteer');

test('2C.3: inbox autenticada, API real, isolamento e navegador', { timeout: 150000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', PUBLIC_APP_URL: '', EVOLUTION_API_URL: 'https://evolution.example.test', EVOLUTION_API_KEY: 'fake-key', EVOLUTION_API_RETRY_ATTEMPTS: '0', MERCADO_PAGO_ACCESS_TOKEN: '' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json()); let fault = null, slow = false;
  app.use((req, res, next) => {
    if (fault && req.path.startsWith('/api/chat/conversations') && req.path.endsWith(fault.path) && req.method === fault.method) return res.status(fault.status).set('Retry-After', '1').json({ error: 'SQL stack trace SECRET tenant_id=99' });
    if (slow && req.path.startsWith('/api/chat/conversations') && req.method === 'POST' && req.path.endsWith('/messages')) return setTimeout(next, 250);
    next();
  });
  app.use('/api', require('../routes')); app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_URL = base;
  const nativeFetch = global.fetch; let externalCalls = 0;
  global.fetch = async (url, options) => { if (String(url).startsWith(base)) return nativeFetch(url, options); externalCalls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); };
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p)); assert.ok(executablePath);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { global.fetch = nativeFetch; await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  const request = async (route, method = 'GET', body, token) => {
    const response = await nativeFetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const accounts = [];
  for (const n of [1, 2]) {
    const signup = await request('/publico/assinaturas', 'POST', { barbeariaNome: 'Studio Inbox ' + n, responsavelNome: 'Ana', telefone: '1199999000' + n, email: `inbox-${n}@example.test`, senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 40 }] }); assert.equal(signup.status, 201);
    const login = await request('/barbeiro/login', 'POST', { identificador: `inbox-${n}@example.test`, senha: 'test-password' });
    accounts.push({ id: signup.body.assinatura.id, token: login.body.token, slug: 'studio-' + signup.body.assinatura.id });
  }
  const [a, b] = accounts, chat = require('../services/chat').createChat(db);
  const create = async (owner, name, phone) => { await chat.start({ slug: owner.slug }, { name, phone }); return (await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1 AND guest_name=$2', [owner.id, name])).id; };
  const customer = (id, content, owner = a) => chat.send({ tenantId: owner.id, conversationId: id }, 'customer', { content, clientMessageId: crypto.randomUUID() });
  const page = await browser.newPage(), errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => network.push({ url: r.url(), method: r.method(), body: r.postData() }));
  page.setDefaultTimeout(10000);
  await page.evaluateOnNewDocument(token => {
    localStorage.setItem('barbearia_auth_token', token);
    const original = window.setInterval; window.panelIntervals = []; window.setInterval = (fn, delay, ...args) => { window.panelIntervals.push(fn); return original(fn, delay, ...args); };
  }, a.token);
  const ready = () => page.waitForFunction(() => document.querySelector('.ci')?.getAttribute('aria-busy') === 'false');
  const click = async selector => { await page.click(selector); await ready(); };
  const fill = (selector, value) => page.$eval(selector, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const send = async content => { await fill('#inboxReply', content); await click('#inboxSend'); };
  const search = async value => { await fill('#inboxSearch', value); await page.$eval('#inboxSearchForm', e => e.requestSubmit()); await ready(); };
  const folder = path.resolve(__dirname, '../../.tmp/chat-inbox-preview'); fs.mkdirSync(folder, { recursive: true });
  let maria, jose, empty, foreign;

  await t.test('trial ativo, menu e inbox vazia nos três tamanhos', async () => {
    await page.setViewport({ width: 1440, height: 1000 }); await page.goto(base + '/studiofy.html'); await page.waitForSelector('[data-section="Conversas"]'); await click('[data-section="Conversas"]');
    assert.match(await page.$eval('#inboxList', e => e.textContent), /Nenhuma conversa ainda/);
    assert.equal(await page.$eval('#inboxBadge', e => e.hidden), true);
    for (const width of [1440, 390, 360]) { await page.setViewport({ width, height: width === 1440 ? 1000 : 800 }); await page.screenshot({ path: path.join(folder, width + '-vazia.png') }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }
  });
  await t.test('lista, ordenação e badge geral vêm do backend; outras contas não aparecem', async () => {
    maria = await create(a, 'Maria Santos', '11988887777'); jose = await create(a, 'José Oliveira', '21977776666'); empty = await create(a, 'Conversa vazia', '31966665555'); foreign = await create(b, 'Cliente privado B', '41955554444');
    await customer(maria, 'Gostaria de agendar um cuidado.'); await customer(jose, 'Qual o horário de atendimento?'); await customer(maria, 'Pode ser amanhã?'); await customer(foreign, 'Segredo do estabelecimento B', b);
    await db.runAsync("UPDATE chat_conversations SET last_message_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [empty]);
    await page.setViewport({ width: 1440, height: 1000 }); await click('#inboxRefresh');
    assert.deepEqual(await page.$$eval('[data-conversation]', es => es.map(e => e.dataset.conversation)), [maria, jose, empty]);
    assert.equal(await page.$eval('#inboxBadge', e => e.textContent), '3');
    assert.doesNotMatch(await page.$eval('#inboxList', e => e.textContent), /privado B|Segredo/);
    const unread = await request('/chat/conversations/unread', 'GET', undefined, a.token); assert.deepEqual(unread.body, { messages: 3, conversations: 2 });
    for (const width of [1440, 390, 360]) { await page.setViewport({ width, height: width === 1440 ? 1000 : 800 }); await page.screenshot({ path: path.join(folder, width + '-lista-nao-lidas.png') }); }
  });
  await t.test('abrir, ler e responder; dados privados sem vínculo inventado', async () => {
    await page.setViewport({ width: 1440, height: 1000 }); await click(`[data-conversation="${maria}"]`);
    assert.equal(await page.$eval('#inboxBadge', e => e.textContent), '1');
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id=$1 AND read_at IS NULL", [maria])).n, 0);
    await page.click('.ci-customer summary'); assert.match(await page.$eval('.ci-customer', e => e.textContent), /11988887777/); assert.match(await page.$eval('.ci-customer', e => e.textContent), /Sem vínculo verificado/);
    assert.equal(await page.$('.ci-customer a'), null);
    slow = true; await fill('#inboxReply', 'Olá, Maria! Temos horários disponíveis.'); await page.click('#inboxSend'); await page.waitForFunction(() => document.querySelector('#inboxNotice').textContent === 'Enviando...'); await ready(); slow = false;
    assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Mensagem enviada/);
    assert.match(await page.$eval('.ci-mine', e => e.textContent), /Olá, Maria/);
    assert.ok(await page.evaluate(() => document.querySelector('.ci-mine').getBoundingClientRect().right > document.querySelector('.ci-theirs').getBoundingClientRect().right));
    const sent = await db.getAsync("SELECT * FROM chat_messages WHERE conversation_id=$1 AND sender_type='establishment'", [maria]); assert.equal(sent.content, 'Olá, Maria! Temos horários disponíveis.');
    assert.equal(await page.$eval('.ci-mine time', e => e.textContent), await page.evaluate(value => new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), sent.created_at));
  });
  await t.test('sem polling; mensagem nova aparece ao atualizar e não lidas são persistidas', async () => {
    await customer(jose, 'Mensagem nova para José'); await customer(maria, 'Mensagem nova para Maria');
    const count = network.length; await page.evaluate(() => window.panelIntervals.forEach(fn => fn())); await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
    assert.equal(network.length, count); assert.doesNotMatch(await page.$eval('#inboxMessages', e => e.textContent), /Mensagem nova/);
    await click('#inboxThreadRefresh'); assert.match(await page.$eval('#inboxMessages', e => e.textContent), /Mensagem nova para Maria/);
    assert.equal(await page.$eval('#inboxBadge', e => e.textContent), '2');
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id=$1 AND read_at IS NULL AND sender_type='customer'", [maria])).n, 0);
  });
  await t.test('busca por nome/telefone é privada, literal e isolada por conta', async () => {
    await search('MARIA'); assert.equal(await page.$$eval('[data-conversation]', es => es.length), 1);
    await search('(21) 97777-6666'); assert.equal(await page.$eval('[data-conversation]', e => e.dataset.conversation), jose);
    await search('41955554444'); assert.match(await page.$eval('#inboxList', e => e.textContent), /Nenhuma conversa encontrada/);
    await search('%'); assert.equal(await page.$$eval('[data-conversation]', es => es.length), 0);
    assert.ok(!network.some(r => /MARIA|97777|55554444|query=/.test(r.url)));
    await search('');
    for (const body of [{ query: 'Cliente privado B' }, { query: '41955554444' }]) { const result = await request('/chat/conversations/search', 'POST', body, a.token); assert.equal(result.status, 200); assert.deepEqual(result.body.conversations, []); }
    for (const body of [{ query: 'x', establishment_id: b.id }, { query: {} }, { query: 'x'.repeat(81) }]) assert.equal((await request('/chat/conversations/search', 'POST', body, a.token)).status, 400);
  });
  await t.test('A não abre, responde ou marca B; sem vazamento de telefone ou conteúdo', async () => {
    for (const [suffix, method, body] of [['messages', 'GET'], ['messages', 'POST', { content: 'Invasão', clientMessageId: crypto.randomUUID() }], ['read', 'POST', { throughMessageId: 1 }]]) {
      const result = await request(`/chat/conversations/${foreign}/${suffix}`, method, body, a.token); assert.equal(result.status, 404); assert.doesNotMatch(JSON.stringify(result.body), /41955554444|Segredo/);
    }
    assert.equal((await request('/chat/conversations/search', 'POST', { query: '' })).status, 401);
    assert.equal((await request('/chat/conversations?establishment_id=' + b.id, 'GET', undefined, a.token)).status, 400);
  });
  await t.test('conversa vazia, XSS, limite e histórico paginado', async () => {
    await click(`[data-conversation="${empty}"]`); assert.match(await page.$eval('#inboxMessages', e => e.textContent), /Nenhuma mensagem ainda/);
    await db.runAsync('INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [empty, 'customer', '<img src=x onerror="window.inboxXss=1">', crypto.randomUUID()]);
    for (let i = 0; i < 55; i++) await db.runAsync("INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '1 day')", [empty, i % 2 ? 'customer' : 'establishment', 'Histórico antigo ' + i, crypto.randomUUID()]);
    await click('#inboxThreadRefresh'); assert.equal(await page.$$eval('.ci-message', es => es.length), 50); await click('#inboxOlder');
    assert.equal(await page.$$eval('.ci-message', es => es.length), 56); assert.equal(await page.$('#inboxMessages img'), null); assert.equal(await page.evaluate(() => window.inboxXss), undefined);
    const count = network.length; await send('<script>alert(1)</script>'); await send('x'.repeat(2001)); assert.equal(network.length, count);
    await send('x'.repeat(2000)); assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Mensagem enviada/);
  });
  await t.test('falhas, rate limit e retry preservam rascunho e idempotência', async () => {
    fault = { path: '/messages', method: 'POST', status: 500 }; await send('Rascunho privado'); assert.equal(await page.$eval('#inboxReply', e => e.value), 'Rascunho privado');
    assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Não foi possível enviar a mensagem/); assert.doesNotMatch(await page.$eval('.ci', e => e.textContent), /SQL|SECRET|tenant_id|stack trace/);
    fault.status = 429; await click('#inboxSend'); assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Muitas tentativas/);
    fault = null; await page.evaluate(() => new Promise(r => setTimeout(r, 1100))); await click('#inboxSend');
    const payloads = network.filter(r => r.method === 'POST' && r.url.endsWith('/messages')).map(r => JSON.parse(r.body)).filter(b => b.content === 'Rascunho privado'); assert.equal(new Set(payloads.map(p => p.clientMessageId)).size, 1);
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM chat_messages WHERE content='Rascunho privado'")).n, 1);
    fault = { path: '/messages', method: 'GET', status: 500 }; await send('Confirmado sem atualização'); assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Mensagem enviada. Não foi possível atualizar/); fault = null;
  });
  await t.test('Evolution 429 não impede leitura ou resposta e não recebe ações da inbox', async () => {
    assert.equal(externalCalls, 0);
    const result = await request(`/publico/assinaturas/${a.id}/whatsapp/status`, 'GET', undefined, a.token); assert.equal(result.status, 429);
    await send('Atendimento independente da Evolution'); assert.equal(externalCalls, 1);
    assert.ok(!network.some(r => /evolution|\/whatsapp\//.test(r.url)));
  });
  await t.test('erro ao abrir no mobile permite voltar à lista e tentar novamente', async () => {
    await page.setViewport({ width: 360, height: 800 }); await page.click('#inboxBack');
    fault = { path: '/messages', method: 'GET', status: 500 }; await click(`[data-conversation="${jose}"]`);
    assert.equal(await page.$eval('.ci', e => e.classList.contains('ci-open')), false);
    assert.match(await page.$eval('#inboxNotice', e => e.textContent), /Não foi possível carregar/);
    await page.screenshot({ path: path.join(folder, '360-erro-carregamento.png'), fullPage: true });
    fault = null; await click(`[data-conversation="${jose}"]`); assert.equal(await page.$eval('#inboxClientName', e => e.textContent), 'José Oliveira');
    assert.equal(await page.$eval('#inboxBadge', e => e.hidden), true);
    await page.setViewport({ width: 1440, height: 1000 });
  });
  await t.test('preview, cliente e teclado: desktop, 390 e 360; lista → conversa → voltar', async () => {
    await click(`[data-conversation="${maria}"]`); await send('Uma resposta longa, com todos os detalhes do atendimento. '.repeat(16));
    await page.click('.ci-customer summary');
    for (const width of [1440, 390, 360]) {
      await page.setViewport({ width, height: width === 1440 ? 1000 : 800 });
      await page.screenshot({ path: path.join(folder, width + '-conversa.png') });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.$eval('#inboxHistory', e => e.scrollWidth <= e.clientWidth + 1));
      if (width !== 1440) {
        await page.setViewport({ width, height: 420 }); await page.focus('#inboxReply');
        await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('.ci').style.getPropertyValue('--ci-vh')) - visualViewport.height) < 1);
        await page.screenshot({ path: path.join(folder, width + '-teclado.png') });
        for (const selector of ['#inboxSend', '#inboxBack']) assert.ok(await page.$eval(selector, e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height >= 44; }));
        await page.setViewport({ width, height: 800 }); await page.click('#inboxBack'); assert.equal(await page.$eval('.ci', e => e.classList.contains('ci-open')), false);
        await page.screenshot({ path: path.join(folder, width + '-voltar.png') });
        await click(`[data-conversation="${maria}"]`);
      }
    }
  });
  await t.test('trial expirado bloqueia operações sem apagar histórico; planos continuam acessíveis', async () => {
    const before = await db.allAsync('SELECT * FROM chat_messages ORDER BY id');
    await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01',trial_ends_at='2000-01-08' WHERE id=$1", [a.id]);
    for (const [route, method, body] of [['/search', 'POST', { query: 'Maria' }], ['', 'GET'], ['/' + maria + '/messages', 'POST', { content: 'Bloqueada', clientMessageId: crypto.randomUUID() }], ['/' + maria + '/read', 'POST', { throughMessageId: 1 }]]) assert.equal((await request('/chat/conversations' + route, method, body, a.token)).status, 403);
    await page.click('#inboxThreadRefresh'); await page.waitForSelector('#subscribe'); assert.equal(await page.$('.ci'), null);
    assert.deepEqual(await db.allAsync('SELECT * FROM chat_messages ORDER BY id'), before);
    assert.equal((await request('/barbeiro/me', 'GET', undefined, a.token)).status, 200);
  });
  await t.test('assinatura ativa restaura inbox; regressão do menu e privacidade', async () => {
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1", [a.id]);
    await page.setViewport({ width: 1440, height: 1000 }); await page.reload(); await page.waitForSelector('[data-section="Conversas"]');
    for (const section of ['Agendamentos', 'Clientes', 'Meus serviços', 'Profissionais', 'Financeiro', 'Horários', 'Minha página', 'Notificações', 'Relatórios', 'Configurações', 'Assinatura', 'Dashboard']) { await page.click(`[data-section="${section}"]`); assert.equal(await page.$eval('#title', e => e.textContent), section); }
    await click('[data-section="Conversas"]'); await click(`[data-conversation="${maria}"]`); await send('Assinatura ativa permite responder.');
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })); assert.doesNotMatch(storage, /Maria|Rascunho|11988887777|Histórico antigo/);
    assert.ok(!network.some(r => /11988887777|Rascunho|Segredo/.test(r.url))); assert.deepEqual(errors, []);
  });
  await t.test('busca inclui páginas além das primeiras 50 e mantém cursores isolados', async () => {
    for (let i = 0; i < 52; i++) await create(b, 'Busca paginada ' + i, '11999990000');
    const first = await request('/chat/conversations/search', 'POST', { query: 'Busca paginada' }, b.token); assert.equal(first.body.conversations.length, 50); assert.ok(first.body.nextCursor);
    const second = await request('/chat/conversations/search', 'POST', { query: 'Busca paginada', cursor: first.body.nextCursor }, b.token); assert.equal(second.body.conversations.length, 2); assert.equal(second.body.nextCursor, null);
    assert.equal(new Set([...first.body.conversations, ...second.body.conversations].map(c => c.id)).size, 52);
    const isolated = await request('/chat/conversations/search', 'POST', { query: 'Busca paginada', cursor: first.body.nextCursor }, a.token); assert.deepEqual(isolated.body.conversations, []);
    const context = await browser.createBrowserContext(), other = await context.newPage();
    try {
      await other.evaluateOnNewDocument(token => localStorage.setItem('barbearia_auth_token', token), b.token);
      await other.goto(base + '/studiofy.html'); await other.waitForSelector('[data-section="Conversas"]'); await other.click('[data-section="Conversas"]');
      await other.waitForFunction(() => document.querySelector('.ci')?.getAttribute('aria-busy') === 'false');
      assert.equal(await other.$$eval('[data-conversation]', es => es.length), 50);
      await other.click('#inboxMore'); await other.waitForFunction(() => document.querySelectorAll('[data-conversation]').length === 53 && document.querySelector('.ci').getAttribute('aria-busy') === 'false');
      assert.equal(await other.$eval('#inboxMore', e => e.hidden), true);
      await other.type('#inboxSearch', 'Busca paginada 0'); await other.$eval('#inboxSearchForm', e => e.requestSubmit());
      await other.waitForFunction(() => document.querySelectorAll('[data-conversation]').length === 1 && document.querySelector('.ci').getAttribute('aria-busy') === 'false');
      assert.match(await other.$eval('#inboxList', e => e.textContent), /Busca paginada 0/);
      assert.doesNotMatch(await other.$eval('#inboxList', e => e.textContent), /Maria Santos/);
    } finally { await context.close(); }
  });
  await t.test('limite real de busca por estabelecimento não bloqueia outra conta', async () => {
    let response;
    for (let i = 0; i < 121; i++) { response = await request('/chat/conversations/search', 'POST', { query: '' }, b.token); if (response.status === 429) break; }
    assert.equal(response.status, 429); assert.doesNotMatch(JSON.stringify(response.body), /SQL|stack|41955554444/);
    assert.equal((await request('/chat/conversations/unread', 'GET', undefined, a.token)).status, 200);
  });
});
