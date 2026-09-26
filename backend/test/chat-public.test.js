const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const puppeteer = require('puppeteer');

test('2C.2: chat público em navegador e PostgreSQL reais', { timeout: 120000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', PUBLIC_APP_URL: '', EVOLUTION_API_URL: 'https://evolution.example.test', EVOLUTION_API_KEY: 'fake-key', EVOLUTION_API_RETRY_ATTEMPTS: '0' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json());
  let fault = null, slowSend = false, chatReads = 0;
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/chat/public/') && req.method === 'GET') chatReads++;
    if (fault && req.path.startsWith('/api/chat/public/') && req.path.endsWith('/messages') && req.method === fault.method) return res.status(fault.status).set('Retry-After', '1').json({ error: 'SQL stack trace internal_id=123 SECRET' });
    if (slowSend && req.path.startsWith('/api/chat/public/') && req.path.endsWith('/messages') && req.method === 'POST') return setTimeout(next, 300);
    next();
  });
  app.use('/api', require('../routes'));
  app.get('/agendar/:slug', (_req, res) => res.sendFile(path.resolve(__dirname, '../public/agendar.html')));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_URL = base;
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath);
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const nativeFetch = global.fetch; let externalCalls = 0;
  global.fetch = async (url, options) => { if (String(url).startsWith(base)) return nativeFetch(url, options); externalCalls++; return Response.json({}, { status: 429, headers: { 'Retry-After': '60' } }); };
  t.after(async () => { global.fetch = nativeFetch; await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await env.cleanup(); });
  const post = async (route, body) => { const r = await nativeFetch(base + '/api' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); };
  const signup = await post('/publico/assinaturas', { barbeariaNome: 'Studio Bella', responsavelNome: 'Pessoa', telefone: '11999995555', email: 'chat-ui@example.test', senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte e cuidado', preco: 40, duracao: 30 }] });
  const accountId = signup.assinatura.id, slug = 'studio-' + accountId;
  const login = await post('/barbeiro/login', { identificador: 'chat-ui@example.test', senha: 'test-password' });
  const page = await browser.newPage(), errors = [], network = [];
  page.on('pageerror', e => errors.push(e.message)); page.on('request', r => network.push({ url: r.url(), method: r.method() }));
  page.setDefaultTimeout(12000);
  const visible = selector => page.waitForSelector(selector, { visible: true });
  const status = text => page.waitForFunction(text => document.querySelector('#chatNotice').textContent.includes(text) && (text === 'Enviando...' || !document.querySelector('#chatSend').disabled), {}, text);
  const fill = (id, value) => page.$eval(id, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const send = async text => { await fill('#chatMessage', text); await page.click('#chatSend'); await status('Mensagem enviada'); };
  let conversationId;

  await t.test('botão, nome, abrir/fechar, foco e Escape sem requests de chat fechado', async () => {
    await page.setViewport({ width: 1440, height: 1000 }); await page.goto(base + '/agendar/' + slug); await visible('[data-service]');
    assert.equal(chatReads, 0); await visible('#chatLauncher'); await page.click('#chatLauncher'); await visible('#chatIdentity');
    assert.equal(await page.$eval('#chatTitle', e => e.textContent), 'Studio Bella');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'chatName');
    await page.keyboard.press('Escape'); assert.equal(await page.$eval('#chatDialog', e => e.open), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'chatLauncher');
    await page.click('#chatLauncher'); await visible('#chatIdentity');
  });
  await t.test('nome obrigatório, telefone validado e identificação cria conversa real', async () => {
    await page.click('#chatStart'); assert.equal(await page.$eval('#chatName', e => e.validity.valueMissing), true);
    await fill('#chatName', 'Ana'); await fill('#chatPhone', '123'); await page.click('#chatStart');
    assert.equal(await page.$eval('#chatPhone', e => e.validity.valid), false);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations')).n, 0);
    await fill('#chatPhone', '(11) 99999-4444'); await page.click('#chatStart'); await visible('#chatConversation');
    conversationId = (await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1', [accountId])).id;
    assert.equal(await page.evaluate(() => document.activeElement.id), 'chatMessage');
    assert.equal(await page.evaluate(() => document.cookie.includes('studiofy_chat')), false);
    assert.equal(page.url(), base + '/agendar/' + slug);
  });
  await t.test('envio com estados, histórico e resposta do estabelecimento sem polling', async () => {
    slowSend = true; await fill('#chatMessage', 'Tem horário amanhã?'); await page.click('#chatSend'); await status('Enviando...'); await status('Mensagem enviada'); slowSend = false;
    assert.match(await page.$eval('.sc-mine', e => e.textContent), /Tem horário amanhã/);
    const reply = await nativeFetch(base + '/api/chat/conversations/' + conversationId + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': login.token }, body: JSON.stringify({ content: 'Olá, Ana! Podemos ajudar.', clientMessageId: crypto.randomUUID() }) });
    assert.equal(reply.status, 201);
    assert.equal(await page.$('.sc-theirs'), null);
    await page.click('#chatRefresh'); await page.waitForFunction(() => document.querySelectorAll('.sc-theirs').length === 1);
    assert.match(await page.$eval('.sc-theirs time', e => e.textContent), /\d{2}:\d{2}/);
    assert.ok((await db.getAsync("SELECT read_at FROM chat_messages WHERE sender_type='establishment'")).read_at);
    const before = chatReads; await page.evaluate(() => new Promise(r => setTimeout(r, 500))); assert.equal(chatReads, before);
  });
  await t.test('sessão é recuperada ao reabrir a página; sem token em URL/storage', async () => {
    await page.reload(); await page.click('#chatLauncher'); await visible('#chatConversation');
    assert.equal(await page.$eval('#chatIdentity', e => e.hidden), true);
    assert.match(await page.$eval('#chatMessages', e => e.textContent), /Tem horário amanhã/);
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations')).n, 1);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    const cookies = await page.cookies(base + '/api/chat/public/' + slug);
    const secret = cookies.find(c => c.name === 'studiofy_chat').value;
    assert.ok(!network.some(r => r.url.includes(secret))); assert.ok(!page.url().includes(conversationId));
    assert.ok(!(await page.content()).includes(secret));
    assert.equal(cookies.find(c => c.name === 'studiofy_chat').httpOnly, true);
    assert.equal(cookies.find(c => c.name === 'studiofy_chat').sameSite, 'Strict');
    await page.click('#chatClose'); await page.click('#chatLauncher'); await visible('#chatConversation');
    assert.equal((await db.getAsync('SELECT count(*)::int AS n FROM chat_conversations')).n, 1);
  });
  await t.test('XSS retornado pelo histórico é texto, não HTML; texto de entrada também validado', async () => {
    await db.runAsync('INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [conversationId, 'establishment', '<img src=x onerror="window.chatXss=1">', crypto.randomUUID()]);
    await page.click('#chatRefresh'); await page.waitForFunction(() => document.querySelector('#chatMessages').textContent.includes('<img'));
    assert.equal(await page.$('#chatMessages img'), null); assert.equal(await page.evaluate(() => window.chatXss), undefined);
    await fill('#chatMessage', '<script>alert(1)</script>'); await page.click('#chatSend'); await status('sem HTML');
  });
  await t.test('histórico paginado pela interface, lados, horários e limite de texto', async () => {
    for (let i = 0; i < 105; i++) await db.runAsync("INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id,created_at) VALUES ($1,$2,$3,$4,clock_timestamp()-interval '1 day')", [conversationId, i % 2 ? 'customer' : 'establishment', 'Histórico ' + i, crypto.randomUUID()]);
    await page.click('#chatRefresh'); await page.waitForFunction(() => document.querySelectorAll('.sc-message').length === 50 && !document.querySelector('#chatOlder').disabled);
    for (let i = 0; i < 2; i++) { await page.click('#chatOlder'); await page.waitForFunction(() => !document.querySelector('#chatOlder').disabled); }
    const rows = await db.allAsync('SELECT * FROM chat_messages WHERE conversation_id=$1 ORDER BY id', [conversationId]);
    assert.deepEqual(await page.$$eval('.sc-message p', elements => elements.map(e => e.textContent)), rows.map(r => r.content));
    assert.equal(await page.$eval('#chatOlder', e => e.hidden), true);
    assert.ok(await page.evaluate(() => document.querySelector('.sc-mine').getBoundingClientRect().right > document.querySelector('.sc-theirs').getBoundingClientRect().right));
    assert.equal(await page.$eval('.sc-message time', e => e.textContent), await page.evaluate(date => new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), rows[0].created_at));
    await send('x'.repeat(2000));
    const before = network.length; await fill('#chatMessage', 'x'.repeat(2001)); await page.click('#chatSend'); await status('até 2.000');
    assert.ok(!network.slice(before).some(r => r.method === 'POST'));
    assert.equal(await page.$eval('#chatMessage', e => e.maxLength), 2000);
  });
  await t.test('falhas e rate limit amigáveis preservam rascunho e UUID do retry', async () => {
    fault = { method: 'POST', status: 500 }; await fill('#chatMessage', 'Mensagem para tentar novamente'); await page.click('#chatSend'); await status('Não foi possível enviar. Tente novamente.');
    assert.equal(await page.$eval('#chatMessage', e => e.value), 'Mensagem para tentar novamente');
    assert.doesNotMatch(await page.$eval('#chatDialog', e => e.textContent), /SQL|stack trace|internal_id|SECRET/);
    fault = { method: 'POST', status: 429 }; await page.click('#chatSend'); await status('Você enviou muitas mensagens');
    fault = null; await page.evaluate(() => new Promise(r => setTimeout(r, 1100))); await page.click('#chatSend'); await status('Mensagem enviada');
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM chat_messages WHERE content='Mensagem para tentar novamente'")).n, 1);
  });
  await t.test('Evolution em 429 não afeta envio no chat e não recebe suas mensagens', async () => {
    assert.equal(externalCalls, 0, 'ações anteriores do chat não chamaram Evolution');
    const response = await nativeFetch(base + `/api/publico/assinaturas/${accountId}/whatsapp/status`, { headers: { 'x-barbeiro-token': login.token } }); assert.equal(response.status, 429);
    const before = externalCalls; await send('Continuamos pelo Studiofy.'); assert.equal(externalCalls, before);
    assert.ok(!network.some(r => /evolution|whatsapp\/(status|qr|iniciar)/.test(r.url)));
  });
  await t.test('envio busca respostas e falha na atualização não perde confirmação', async () => {
    await db.runAsync('INSERT INTO chat_messages(conversation_id,sender_type,content,client_message_id) VALUES ($1,$2,$3,$4)', [conversationId, 'establishment', 'Resposta recuperada após envio', crypto.randomUUID()]);
    const reads = chatReads; await send('Atualização depois do envio'); assert.ok(chatReads > reads);
    assert.match(await page.$eval('#chatMessages', e => e.textContent), /Resposta recuperada após envio/);
    fault = { method: 'GET', status: 500 }; await send('Envio confirmado mesmo sem atualização'); await status('Não foi possível atualizar'); fault = null;
    await page.click('#chatRefresh'); await page.waitForFunction(() => !document.querySelector('#chatRefresh').disabled);
    assert.equal((await db.getAsync("SELECT count(*)::int AS n FROM chat_messages WHERE content='Envio confirmado mesmo sem atualização'")).n, 1);
    assert.equal(externalCalls, 1, 'somente consulta WhatsApp explícita chamou Evolution');
  });
  await t.test('trial expirado informa indisponibilidade neutra; assinatura ativa reabre histórico', async () => {
    const before = await db.allAsync('SELECT * FROM chat_messages ORDER BY id');
    await db.runAsync("UPDATE assinaturas SET trial_started_at='2000-01-01T00:00:00.000Z',trial_ends_at='2000-01-08T00:00:00.000Z' WHERE id=$1", [accountId]);
    await page.click('#chatRefresh'); await status('temporariamente indisponível');
    assert.equal(await page.$eval('#chatConversation', e => e.hidden), true);
    assert.doesNotMatch(await page.$eval('#chatNotice', e => e.textContent), /trial|assinatura|pagamento|vencid/i);
    assert.deepEqual(await db.allAsync('SELECT * FROM chat_messages ORDER BY id'), before);
    await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',proximo_vencimento='2099-01-01' WHERE id=$1", [accountId]);
    await page.click('#chatClose'); await page.click('#chatLauncher'); await visible('#chatConversation'); await send('Assinatura ativa.');
  });
  await t.test('preview desktop, 390 e 360: estados, textos longos, foco e viewport reduzido', async () => {
    const folder = path.resolve(__dirname, '../../.tmp/chat-public-preview'); fs.mkdirSync(folder, { recursive: true });
    await send('Uma mensagem longa para conferir o conforto da leitura. '.repeat(15));
    for (const width of [1440, 390, 360]) {
      await page.setViewport({ width, height: width === 1440 ? 1000 : 800 });
      await page.click('#chatClose'); await page.screenshot({ path: path.join(folder, `${width}-fechado.png`) });
      await page.click('#chatLauncher'); await visible('#chatConversation'); await page.screenshot({ path: path.join(folder, `${width}-conversa.png`) });
      await page.$eval('#chatHistory', e => { e.scrollTop = 0; }); await page.screenshot({ path: path.join(folder, `${width}-mensagens-curtas.png`) });
      await page.$eval('#chatHistory', e => { e.scrollTop = e.scrollHeight; });
      fault = { method: 'POST', status: 500 }; await fill('#chatMessage', 'Mensagem não enviada'); await page.click('#chatSend'); await status('Não foi possível enviar');
      await page.screenshot({ path: path.join(folder, `${width}-erro.png`) }); fault = null;
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.$eval('#chatHistory', e => e.scrollWidth <= e.clientWidth + 1));
      const fresh = await browser.createBrowserContext(); const identityPage = await fresh.newPage();
      await identityPage.setViewport({ width, height: width === 1440 ? 1000 : 800 }); await identityPage.goto(base + '/agendar/' + slug); await identityPage.click('#chatLauncher'); await identityPage.waitForSelector('#chatIdentity', { visible: true });
      await identityPage.screenshot({ path: path.join(folder, `${width}-identificacao.png`) }); await fresh.close();
      if (width !== 1440) {
        await page.setViewport({ width, height: 420 }); await page.focus('#chatMessage');
        await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('#chatDialog').style.getPropertyValue('--sc-height')) - visualViewport.height) < 1);
        await page.screenshot({ path: path.join(folder, `${width}-teclado.png`) });
        assert.ok(await page.$eval('#chatSend', e => { const r = e.getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
        assert.ok(await page.$eval('#chatClose', e => e.getBoundingClientRect().width >= 44));
        await page.setViewport({ width, height: 800 });
      }
    }
  });
  await t.test('labels, ARIA, navegação por Tab e retorno de foco', async () => {
    await page.focus('#chatClose'); await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
    assert.ok(await page.evaluate(() => document.querySelector('#chatDialog').contains(document.activeElement)));
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'chatClose');
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => document.querySelector('#chatDialog').contains(document.activeElement))); }
    assert.equal(await page.$eval('#chatDialog', e => e.getAttribute('aria-labelledby')), 'chatTitle');
    assert.equal(await page.$eval('#chatNotice', e => e.getAttribute('role')), 'status');
    for (const id of ['chatName', 'chatPhone', 'chatMessage']) assert.ok(await page.$(`label[for="${id}"]`));
    for (const id of ['chatClose', 'chatRefresh', 'chatSend']) assert.ok(await page.$eval('#' + id, e => { const r = e.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; }));
    const contrasts = await page.evaluate(() => {
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      return ['#chatIdentityForm label', '.sc-note', '.sc-mine', '.sc-mine time', '.sc-theirs', '.sc-theirs time', '#chatRefresh', '#chatNotice', '.sc-footer'].map(selector => {
        const el = document.querySelector(selector); let parent = el, bg;
        do { bg = getComputedStyle(parent).backgroundColor; parent = parent.parentElement; } while (bg === 'rgba(0, 0, 0, 0)' && parent);
        const fg = luminance(getComputedStyle(el).color), background = luminance(bg);
        return { selector, ratio: (Math.max(fg, background) + 0.05) / (Math.min(fg, background) + 0.05) };
      });
    });
    for (const { selector, ratio } of contrasts) assert.ok(ratio >= 4.5, `${selector}: contraste ${ratio}`);
    await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'chatLauncher');
    await page.click('#chatLauncher'); await visible('#chatConversation');
  });
  await t.test('agendamento completo e cancelamento preservados após uso do chat', async () => {
    await page.click('#chatClose'); await page.click('[data-service]');
    const day = new Date(Date.now() + 3 * 86400000); if (day.getDay() === 0) day.setDate(day.getDate() + 1);
    await page.$eval('#date', (e, value) => { e.value = value; e.dispatchEvent(new Event('change')); }, day.toISOString().slice(0, 10));
    await visible('[data-time]'); await page.click('[data-time]'); await fill('#name', 'Cliente do agendamento'); await fill('#phone', '11999993333');
    await page.click('#chatLauncher'); await visible('#chatConversation'); await page.click('#chatClose');
    assert.ok(await page.$('[data-time].selected')); await page.click('#review'); await page.click('#confirm'); await visible('#cancelBooking');
    await page.click('#cancelBooking'); await page.click('#confirmCancellation'); await page.waitForFunction(() => document.querySelector('#booking').textContent.includes('cancelado com sucesso'));
    assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE assinatura_id=$1', [accountId])).status, 'cancelado');
    assert.deepEqual(errors, []);
  });
  await t.test('regressão serviço, profissional, data, horário e confirmação em três estados do chat', async () => {
    const requestSets = [];
    for (const mode of ['fechado', 'identificação aberta', 'conversa existente']) {
      const context = mode === 'conversa existente' ? null : await browser.createBrowserContext();
      const bookingPage = await (context || browser).newPage(); const requests = [];
      await bookingPage.setViewport({ width: 1440, height: 1000 });
      bookingPage.on('request', r => { if (r.url().includes('/api/studiofy/public/')) requests.push({ url: r.url(), method: r.method(), body: r.postData() }); });
      try {
        await bookingPage.goto(base + '/agendar/' + slug); await bookingPage.waitForSelector('[data-service]');
        const checkOverlay = async () => {
          if (mode === 'fechado') return;
          const before = await bookingPage.$eval('#booking', e => ({ html: e.innerHTML, values: [...e.querySelectorAll('input,select')].map(e => e.value) }));
          const count = requests.length;
          await bookingPage.click('#chatLauncher'); await bookingPage.waitForSelector(mode === 'conversa existente' ? '#chatConversation' : '#chatIdentity', { visible: true });
          // O dialog é modal: o usuário fecha o chat para continuar o formulário.
          await bookingPage.keyboard.press('Escape');
          assert.deepEqual(await bookingPage.$eval('#booking', e => ({ html: e.innerHTML, values: [...e.querySelectorAll('input,select')].map(e => e.value) })), before);
          assert.equal(requests.length, count, 'abrir/fechar chat não requisita agendamento');
        };
        await checkOverlay(); await bookingPage.click('[data-service]');
        const professionalId = await bookingPage.$eval('#professional option', e => e.value); await bookingPage.select('#professional', professionalId);
        const day = new Date(Date.now() + 4 * 86400000); if (day.getDay() === 0) day.setDate(day.getDate() + 1);
        await bookingPage.$eval('#date', (e, value) => { e.value = value; e.dispatchEvent(new Event('change')); }, day.toISOString().slice(0, 10));
        await bookingPage.waitForSelector('[data-time]'); await bookingPage.click('[data-time]');
        await bookingPage.type('#name', 'Cliente regressão'); await bookingPage.type('#phone', '11999992222'); await checkOverlay();
        await bookingPage.click('#review'); await checkOverlay(); await bookingPage.click('#confirm'); await bookingPage.waitForSelector('#cancelBooking');
        assert.match(await bookingPage.$eval('#booking', e => e.textContent), /Agendamento confirmado/);
        await checkOverlay(); await bookingPage.click('#cancelBooking'); await bookingPage.click('#confirmCancellation');
        await bookingPage.waitForFunction(() => document.querySelector('#booking').textContent.includes('cancelado com sucesso'));
        requestSets.push(requests.filter(r => !r.url.includes('/reservas/')));
      } finally { await bookingPage.close(); if (context) await context.close(); }
    }
    assert.deepEqual(requestSets[1], requestSets[0]); assert.deepEqual(requestSets[2], requestSets[0]);
  });
});
