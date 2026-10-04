const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const puppeteer = require('puppeteer');

test('Studiofy WhatsApp: tela, rotas reais, isolamento e Evolution simulada', { timeout: 120000 }, async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, { NODE_ENV: 'test', RENDER: 'false', PUBLIC_APP_URL: '', EVOLUTION_API_URL: 'https://evolution.studiofy.test', EVOLUTION_API_KEY: 'fake-test-key', EVOLUTION_API_RETRY_DELAY_MS: '1', MERCADO_PAGO_ACCESS_TOKEN: '' });
  const db = require('../database'); await db.ready;
  const app = express(); app.use(express.json()); app.use('/api', require('../routes')); app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`; process.env.PUBLIC_APP_URL = base;
  const originalFetch = global.fetch, instances = new Map(), upstream = [];
  let fault = null, releaseConnect = null, holdConnect = false, pendingQr = false, backendOffset = 0;
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + backendOffset);
  // Synthetic QR-shaped image: never a live session or payment code.
  const blocks = Array.from({ length: 25 * 25 }, (_, i) => ((i * 17 + Math.floor(i / 25) * 13) % 7 < 3) ? '<rect x="' + (i % 25 + 3) * 8 + '" y="' + (Math.floor(i / 25) + 3) * 8 + '" width="8" height="8"/>' : '').join('');
  const png = await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="248" height="248"><rect width="248" height="248" fill="white"/>' + blocks + '</svg>')).png().toBuffer();
  const qr = 'data:image/png;base64,' + png.toString('base64');
  global.fetch = async (url, options = {}) => {
    if (String(url).startsWith(base)) return originalFetch(url, options);
    const u = new URL(url), name = u.pathname.split('/').pop();
    upstream.push({ path: u.pathname, method: options.method, number: u.searchParams.get('number') });
    if (fault) return Response.json({ error: 'provider test failure' }, { status: fault, headers: { 'Retry-After': '90' } });
    if (u.pathname.startsWith('/webhook/')) return Response.json({ success: true });
    if (u.pathname === '/instance/create') { const body = JSON.parse(options.body); assert.equal(body.qrcode, false); instances.set(body.instanceName, { state: 'close' }); return Response.json({ instance: { instanceName: body.instanceName } }); }
    const instance = instances.get(name);
    if (!instance) return Response.json({ status: 404, error: 'Not Found', response: { message: [`The "${name}" instance does not exist`] } }, { status: 404 });
    if (u.pathname.startsWith('/instance/connectionState/')) return Response.json({ instance });
    if (u.pathname.startsWith('/instance/connect/')) {
      if (holdConnect) await new Promise(resolve => { releaseConnect = resolve; });
      if (instance.state === 'open') return Response.json({ instance });
      upstream.at(-1).startedSocket = instance.state === 'close';
      instance.state = 'connecting'; return Response.json(pendingQr ? { count: 0 } : u.searchParams.has('number') ? { pairingCode: 'ABCD1234' } : { base64: qr });
    }
    if (u.pathname.startsWith('/instance/logout/')) { instance.state = 'close'; delete instance.base64; return Response.json({ success: true }); }
    throw Error('Unexpected upstream endpoint: ' + u.pathname);
  };
  let browser;
  t.after(async () => { releaseConnect?.(); await browser?.close(); global.fetch = originalFetch; server.closeAllConnections(); await new Promise(r => server.close(r)); await db.close(); await environment.cleanup(); });
  const api = async (route, token, method = 'GET', body) => {
    const r = await originalFetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', 'x-barbeiro-token': token || '' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const accounts = [];
  for (const n of [1, 2]) {
    const signup = await api('/publico/assinaturas', null, 'POST', { barbeariaNome: 'WhatsApp teste ' + n, responsavelNome: 'Teste', telefone: '1199999300' + n, email: `studiofy-wa-${n}@example.test`, senha: 'test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5, servicos: [{ nome: 'Corte', preco: 40 }] }); assert.equal(signup.status, 201);
    const login = await api('/barbeiro/login', null, 'POST', { identificador: `studiofy-wa-${n}@example.test`, senha: 'test-password' }); assert.equal(login.status, 200);
    accounts.push({ id: signup.body.assinatura.id, token: login.body.token });
  }
  const [a, b] = accounts, route = `/publico/assinaturas/${a.id}/whatsapp`, name = 'barbearia-' + a.id;
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p)); assert.ok(executablePath);
  browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage(), errors = [], network = [];
  page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => network.push({ url: r.url(), method: r.method() }));
  await page.evaluateOnNewDocument(token => {
    localStorage.setItem('barbearia_auth_token', token);
    const set = window.setTimeout, clear = window.clearTimeout, now = Date.now, interval = window.setInterval;
    let offset = 0, id = -1; const timers = new Map();
    Date.now = () => now() + offset;
    window.setTimeout = (fn, delay, ...args) => { if (!String(fn).includes('s.polls++')) return set(fn, delay, ...args); timers.set(--id, { fn, at: Date.now() + delay }); return id; };
    window.clearTimeout = key => key < 0 ? timers.delete(key) : clear(key);
    window.waAdvance = ms => { offset += ms; for (const [key, entry] of [...timers]) if (entry.at <= Date.now()) { timers.delete(key); entry.fn(); } };
    window.waDelays = () => [...timers.values()].map(t => t.at - Date.now());
    window.panelRefresh = () => {};
    window.setInterval = (fn, delay, ...args) => { if (delay === 30000) window.panelRefresh = fn; return interval(fn, delay, ...args); };
  }, a.token);
  const connectCalls = () => upstream.filter(c => c.path.startsWith('/instance/connect/')).length;
  const waRequests = () => network.filter(r => r.url.includes('/whatsapp/')).length;
  const ready = () => page.waitForFunction(() => !document.querySelector('#whatsappRefresh')?.disabled);
  const tick = async ms => { backendOffset += ms; await page.evaluate(ms => window.waAdvance(ms), ms); await ready(); };
  const open = async () => { await page.click('[data-section="WhatsApp"]'); await ready(); };
  const disconnect = async () => { await page.click('#whatsappDisconnect'); await page.waitForSelector('#whatsappConfirm[open]'); await page.click('#whatsappConfirmDisconnect'); await ready(); };
  const folder = path.resolve(__dirname, '../../.tmp/studiofy-whatsapp-preview'); fs.mkdirSync(folder, { recursive: true });

  await t.test('menu fica entre Agendamentos e Conversas; dashboard não consulta WhatsApp', async () => {
    await page.setViewport({ width: 1440, height: 1000 }); await page.goto(base + '/studiofy.html'); await page.waitForSelector('[data-section="WhatsApp"]');
    assert.deepEqual(await page.$$eval('[data-section]', es => es.slice(0, 5).map(e => e.dataset.section)), ['Dashboard', 'Agendamentos', 'WhatsApp', 'Conversas', 'Clientes']);
    assert.equal(waRequests(), 0); assert.equal(upstream.length, 0);
  });
  await t.test('desconectado: consulta única e nenhuma criação ou connect automáticos', async () => {
    await open(); assert.equal(await page.$eval('#title', e => e.textContent), 'Conectar WhatsApp');
    assert.match(await page.$eval('#whatsappState', e => e.textContent), /WhatsApp desconectado/);
    assert.equal(await page.$eval('#whatsappConnect', e => e.disabled), false);
    assert.equal(connectCalls(), 0); const count = waRequests(); await page.evaluate(() => window.panelRefresh()); await tick(60000); assert.equal(waRequests(), count);
  });
  await t.test('cliques duplicados iniciam somente uma conexão e exibem QR sem repetir connect', async () => {
    holdConnect = true;
    await page.evaluate(() => { const b = document.getElementById('whatsappConnect'); b.click(); b.dispatchEvent(new MouseEvent('click')); });
    await page.waitForFunction(() => document.querySelector('#whatsappState').textContent === 'Preparando conexão...');
    for (let i = 0; i < 100 && !releaseConnect; i++) await new Promise(r => setTimeout(r, 10)); assert.ok(releaseConnect);
    assert.equal(connectCalls(), 1); releaseConnect(); holdConnect = false; await ready(); await page.waitForSelector('#whatsappQrArea', { visible: true });
    assert.equal(await page.$eval('#whatsappQr', e => e.src), qr); assert.equal(await page.$$eval('#whatsappQrArea .sw-instructions li', es => es.length), 4);
    await page.evaluate(() => document.getElementById('whatsappConnect').dispatchEvent(new MouseEvent('click'))); assert.equal(connectCalls(), 1);
  });
  await t.test('QR e controles cabem em desktop, 390 e 360', async () => {
    for (const width of [1440, 390, 360]) {
      await page.setViewport({ width, height: width === 1440 ? 1000 : 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await page.$$eval('#navigation button', buttons => buttons.every(button => {
        const nav = button.parentElement.getBoundingClientRect(), rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.left >= nav.left && rect.right <= nav.right + 1 && rect.left >= 0 && rect.right <= innerWidth && button.scrollWidth <= button.clientWidth;
      })), 'All menu buttons and labels fit without horizontal clipping');
      if (width < 850) {
        await page.evaluate(() => scrollTo(0, 0));
        assert.ok(await page.$eval('[data-section="WhatsApp"]', button => {
          const rect = button.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight && document.elementFromPoint(rect.right - 2, rect.top + rect.height / 2)?.closest('button') === button;
        }), 'WhatsApp is fully visible in the initial mobile viewport');
      }
      assert.ok(await page.$eval('#whatsappQr', e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width >= 200 && Math.abs(r.width - r.height) < 1 && e.naturalWidth > 0; }));
      await page.$eval('.sw-card', e => e.scrollIntoView()); await page.screenshot({ path: path.join(folder, `qr-${width}.png`), fullPage: true });
    }
    await page.setViewport({ width: 1440, height: 1000 });
  });
  await t.test('outra aba recupera tentativa pelo status e não permite novo connect', async () => {
    const other = await browser.newPage(); const count = connectCalls();
    try {
      await other.goto(base + '/studiofy.html'); await other.waitForSelector('[data-section="WhatsApp"]'); await other.click('[data-section="WhatsApp"]');
      await other.waitForFunction(() => !document.querySelector('#whatsappRefresh').disabled);
      assert.equal(await other.$eval('#whatsappConnect', e => e.hidden), true);
      assert.equal(connectCalls(), count);
    } finally { await other.close(); await page.bringToFront(); }
    await page.click('#whatsappRefresh'); await ready();
  });
  await t.test('polling e atualização manual consultam apenas estado; conectado mostra número real', async () => {
    const count = connectCalls(); await tick(15000); await page.click('#whatsappRefresh'); await ready(); assert.equal(connectCalls(), count);
    assert.equal(instances.get(name).state, 'connecting');
    assert.equal(await page.$eval('#whatsappState', e => e.textContent), 'Aguardando leitura do QR Code', 'Intermediate status alone does not prove that the QR was scanned');
    instances.set(name, { state: 'open', ownerJid: '5511988887777:4@s.whatsapp.net' }); await tick(15000);
    assert.match(await page.$eval('#whatsappState', e => e.textContent), /WhatsApp conectado/); assert.equal(await page.$eval('#whatsappNumber', e => e.textContent), 'Número conectado: +5511988887777');
    assert.equal(await page.$eval('#whatsappQrArea', e => e.hidden), true); assert.equal((await page.evaluate(() => window.waDelays())).length, 0);
    delete instances.get(name).ownerJid; backendOffset += 10001; await page.click('#whatsappRefresh'); await ready(); assert.equal(await page.$eval('#whatsappNumber', e => e.hidden), true);
  });
  await t.test('desconexão exige confirmação; cancelar preserva conexão', async () => {
    const count = upstream.length; await page.click('#whatsappDisconnect'); await page.waitForSelector('#whatsappConfirm[open]'); await page.click('#whatsappCancel'); assert.equal(upstream.length, count);
    assert.equal(instances.get(name).state, 'open'); await disconnect(); assert.equal(instances.get(name).state, 'close'); assert.match(await page.$eval('#whatsappState', e => e.textContent), /desconectado/);
  });
  await t.test('QR pendente é recuperado por status sem novo connect', async () => {
    pendingQr = true; await page.click('#whatsappConnect'); await ready(); const count = connectCalls();
    assert.equal(await page.$eval('#whatsappQrArea', e => e.hidden), true);
    // Evolution 2.3.7 emits the QR separately from connectionState.
    process.env.EVOLUTION_WEBHOOK_SECRET = 'synthetic-browser-secret';
    const response = await originalFetch(base + '/api/webhook/evolution', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'synthetic-browser-secret' },
      body: JSON.stringify({ event: 'qrcode.updated', instance: name, data: { qrcode: { base64: qr } } }) });
    assert.equal(response.status, 200);
    await page.click('#whatsappRefresh'); await ready(); await page.waitForSelector('#whatsappQrArea', { visible: true });
    assert.equal(connectCalls(), count); pendingQr = false;
  });
  await t.test('sair da seção, refresh geral e retorno não repetem connect; aba oculta pausa', async () => {
    const count = connectCalls(); await page.click('[data-section="Agendamentos"]'); const requests = waRequests(); await page.evaluate(() => window.waAdvance(60000)); assert.equal(waRequests(), requests);
    assert.ok(await page.$('#newBooking')); await open(); assert.equal(connectCalls(), count);
    await page.evaluate(() => { window.waHidden = true; Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.waHidden }); document.dispatchEvent(new Event('visibilitychange')); });
    const paused = waRequests(); await page.evaluate(() => window.waAdvance(60000)); assert.equal(waRequests(), paused);
    await page.evaluate(() => { window.waHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(waRequests(), paused); await page.click('#whatsappRefresh'); await ready(); assert.equal(connectCalls(), count);
  });
  await t.test('isolamento A/B e parâmetros forjados nunca controlam outra instância', async () => {
    const count = upstream.length;
    for (const [suffix, method] of [['status', 'GET'], ['iniciar', 'POST'], ['logout', 'DELETE']]) {
      assert.equal((await api(route + '/' + suffix, b.token, method, method === 'POST' ? {} : undefined)).status, 403);
      assert.equal((await api(route + '/' + suffix, null, method, method === 'POST' ? {} : undefined)).status, 401);
    }
    assert.equal(upstream.length, count);
    const own = await api(route + '/status?establishment_id=' + b.id, a.token); assert.equal(own.status, 200); assert.ok(upstream.slice(count).every(c => c.path.endsWith('/' + name)));
    const forged = await api(route + '/iniciar', a.token, 'POST', { establishment_id: b.id, instanceName: 'barbearia-' + b.id }); assert.equal(forged.status, 200); assert.equal(connectCalls(), 2);
  });
  await t.test('backoff de falhas de status é limitado e não gera novos connects', async () => {
    await disconnect(); await page.click('#whatsappConnect'); await ready(); fault = 503; const connects = connectCalls();
    await tick(15000); assert.ok((await page.evaluate(() => window.waDelays()))[0] > 29000);
    await tick(30000); assert.ok((await page.evaluate(() => window.waDelays()))[0] > 59000);
    await tick(60000); assert.equal((await page.evaluate(() => window.waDelays())).length, 0); assert.equal(connectCalls(), connects); fault = null;
    await disconnect();
  });
  await t.test('prazo de três minutos encerra consultas sem liberar outro connect', async () => {
    await page.click('#whatsappConnect'); await ready(); const count = waRequests(), connects = connectCalls();
    await tick(180000); assert.equal(waRequests(), count); assert.equal(connectCalls(), connects);
    assert.match(await page.$eval('#whatsappNotice', e => e.textContent), /acompanhamento terminou/);
    assert.equal(await page.$eval('#whatsappRetry', e => e.hidden), false); assert.equal((await page.evaluate(() => window.waDelays())).length, 0);
    await disconnect();
  });
  await t.test('pareamento brasileiro: duas opcoes, telefone, clique duplicado, codigo e open', async () => {
    assert.equal(await page.$eval('#whatsappConnect', e => e.hidden), false);
    assert.equal(await page.$eval('#whatsappPairing', e => e.hidden), false);
    assert.equal(await page.$eval('#whatsappDisconnect', e => e.hidden), true);
    await page.click('#whatsappPairing'); await page.type('#whatsappPhone', '+55 (11) 99999-9999');
    const before = connectCalls();
    await page.evaluate(() => { const f = document.getElementById('whatsappPairingForm'); f.dispatchEvent(new Event('submit', { cancelable: true })); f.dispatchEvent(new Event('submit', { cancelable: true })); });
    await ready(); await page.waitForSelector('#whatsappPairingArea', { visible: true });
    assert.equal(connectCalls(), before + 1);
    assert.equal(upstream.filter(c => c.path.includes('/connect/')).at(-1).number, '5511999999999');
    assert.equal(await page.$eval('#whatsappPairingValue', e => e.textContent), 'ABCD-1234');
    assert.equal(await page.$eval('#whatsappQrArea', e => e.hidden), true);
    assert.ok(network.every(r => !r.url.includes('fake-test-key')));
    instances.set(name, { state: 'open' }); await tick(15000);
    assert.equal(await page.$eval('#whatsappPairingArea', e => e.hidden), true);
    await disconnect();
  });
  await t.test('QR ausente sai de preparando em 60s e recuperacao explicita preserva socket', async () => {
    pendingQr = true; await page.click('#whatsappConnect'); await ready();
    const starts = upstream.filter(c => c.startedSocket).length;
    await tick(60001);
    assert.equal(await page.$eval('#whatsappRetry', e => e.hidden), false);
    assert.equal(await page.$eval('#whatsappState', e => e.textContent), 'C\u00f3digo de conex\u00e3o indispon\u00edvel');
    pendingQr = false; await page.click('#whatsappRetry'); await ready();
    await page.waitForSelector('#whatsappQrArea', { visible: true });
    assert.equal(upstream.filter(c => c.startedSocket).length, starts);
    await tick(60001);
    assert.equal(await page.$eval('#whatsappQrArea', e => e.hidden), true);
    await page.click('#whatsappRetry'); await ready();
    await page.waitForSelector('#whatsappQrArea', { visible: true });
    assert.equal(upstream.filter(c => c.startedSocket).length, starts);
    assert.equal(upstream.filter(c => /delete|restart/.test(c.path)).length, 0);
    await disconnect();
  });
  await t.test('429 de status preserva QR e tentativa; tela explica origem sem reconectar', async () => {
    await page.click('#whatsappConnect'); await ready();
    const count = connectCalls(); fault = 429; backendOffset += 10001;
    await page.click('#whatsappRefresh');
    await page.waitForFunction(() => document.querySelector('#whatsappNotice').textContent.includes('HTTP 429'));
    assert.equal(await page.$eval('#whatsappQrArea', e => e.hidden), false);
    assert.match(await page.$eval('#whatsappNotice', e => e.textContent), /Referência: .*Etapa: \/instance\/connectionState\//);
    assert.equal(require('../evolutionApi').tentativaConexaoAtiva(name), true);
    assert.equal((await page.evaluate(() => window.waDelays())).length, 0);
    fault = null; await tick(90001);
    await page.click('#whatsappRefresh'); await ready();
    assert.equal(connectCalls(), count);
    await disconnect();
  });
  await t.test('429 respeita Retry-After, cancela polling e mantém cooldown entre seções', async () => {
    fault = 429; await page.click('#whatsappConnect');
    await page.waitForFunction(() => document.querySelector('#whatsappNotice').textContent.includes('temporariamente indisponível'));
    assert.equal(await page.$eval('#whatsappRefresh', e => e.disabled), true); assert.equal((await page.evaluate(() => window.waDelays())).length, 0);
    const count = upstream.length, requests = waRequests(); await page.evaluate(() => { document.getElementById('whatsappConnect').dispatchEvent(new MouseEvent('click')); document.getElementById('whatsappRefresh').dispatchEvent(new MouseEvent('click')); window.waAdvance(30000); }); assert.equal(waRequests(), requests);
    await page.click('[data-section="Agendamentos"]'); await page.click('[data-section="WhatsApp"]'); assert.equal(waRequests(), requests);
    assert.match(await page.$eval('#whatsappNotice', e => e.textContent), /temporariamente indisponível/);
    await page.evaluate(() => window.waAdvance(90000)); await ready(); assert.equal(waRequests(), requests, 'Expiry never triggers automatic retries');
    await page.click('#whatsappRefresh'); await page.waitForFunction(() => document.querySelector('#whatsappRefresh').disabled && document.querySelector('#whatsappNotice').textContent.includes('temporariamente indisponível')); assert.equal(upstream.length, count, 'Backend cooldown still blocks upstream');
    await page.screenshot({ path: path.join(folder, 'rate-limit.png'), fullPage: true });
  });
  await t.test('Chat Studiofy e Agendamentos continuam disponíveis com Evolution em 429', async () => {
    const before = upstream.length;
    const chat = require('../services/chat').createChat(db); const started = await chat.start({ tenantId: a.id }, { name: 'Cliente de teste', phone: '11977776666' });
    const conversation = (await db.getAsync('SELECT id FROM chat_conversations WHERE assinatura_id=$1', [a.id])).id;
    await chat.send({ slug: 'studio-' + a.id, token: started.token }, 'customer', { content: 'Chat funciona com Evolution indisponível', clientMessageId: crypto.randomUUID() });
    await page.click('[data-section="Conversas"]'); await page.waitForFunction(() => document.querySelector('.ci')?.getAttribute('aria-busy') === 'false'); await page.click(`[data-conversation="${conversation}"]`); await page.waitForFunction(() => document.querySelector('.ci')?.getAttribute('aria-busy') === 'false');
    await page.type('#inboxReply', 'Resposta independente'); await page.click('#inboxSend'); await page.waitForFunction(() => document.querySelector('#inboxNotice').textContent === 'Mensagem enviada.');
    const history = await chat.history({ slug: 'studio-' + a.id, token: started.token }, 'customer', {}); assert.ok(history.messages.some(m => m.content === 'Resposta independente'));
    await page.click('[data-section="Agendamentos"]'); assert.ok(await page.$('#newBooking')); assert.equal(upstream.length, before); assert.deepEqual(errors, []);
  });
});
