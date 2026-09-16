const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((candidate) => candidate && fs.existsSync(candidate));

test('painel WhatsApp no navegador', { skip: !executablePath }, async (t) => {
  let connected = false;
  let pairingError = false;
  let statusError = false;
  let statusErrorCode = '';
  let statusHttp = 503;
  let delay = 0;
  let pairingCalls = 0;
  let statusCalls = 0;
  let rateLimited = false;
  const app = express();
  app.use(express.json());
  app.get('/api/publico/assinatura-config', (_, res) => res.json({ whatsappEnabled: true }));
  app.get('/api/barbeiro/me', (_, res) => res.json({ id: 1, status: 'ativo', servicos: [] }));
  app.get('/api/faturamento', (_, res) => res.json({ total: 0 }));
  app.get(['/api/agendamentos', '/api/bloqueios'], (_, res) => res.json([]));
  app.get('/api/publico/assinaturas/1/whatsapp/status', (_, res) => { statusCalls++; return statusError
    ? res.status(statusHttp).json({ success: false, message: 'Servidor do WhatsApp indisponivel.', errorCode: statusErrorCode, retryAfterSeconds: statusHttp === 429 ? 45 : undefined })
    : res.json({ success: true, connected, status: connected ? 'connected' : 'pairing' }); });
  app.post('/api/publico/assinaturas/1/whatsapp/pairing-code', async (req, res) => {
    pairingCalls++;
    if (rateLimited) return res.status(429).set('Retry-After', '60').json({ errorCode: 'EVOLUTION_RATE_LIMIT', retryAfterSeconds: 60 });
    assert.equal(req.body.phone, '75983179933');
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (pairingError) return res.status(502).json({ message: 'Nao foi possivel gerar o codigo de conexao.' });
    res.json({ success: true, status: 'pairing_code', code: 'ABCD1234' });
  });
  app.post('/api/publico/assinaturas/1/whatsapp/iniciar', (_, res) => res.json({
    success: true, status: 'success', qrCode: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo4AAAAASUVORK5CYII=',
  }));
  app.delete('/api/publico/assinaturas/1/whatsapp/logout', (_, res) => {
    connected = false;
    res.json({ success: true, status: 'disconnected', connected: false });
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); await new Promise((resolve) => server.close(resolve)); });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(() => localStorage.setItem('barbearia_auth_token', 'test-token'));
  await page.goto(`http://127.0.0.1:${server.address().port}/barbeiro.html`);
  await page.waitForFunction(() => !document.getElementById('generatePairingButton').disabled);
  await page.type('#whatsappPairingNumber', '75983179933');

  await t.test('um clique e duplo clique enviam somente um POST por operacao', async () => {
    delay = 100;
    let before = pairingCalls;
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => !document.getElementById('generatePairingButton').disabled);
    assert.equal(pairingCalls - before, 1);
    before = pairingCalls;
    await page.evaluate(() => {
      const button = document.getElementById('generatePairingButton');
      button.dispatchEvent(new MouseEvent('click'));
      button.dispatchEvent(new MouseEvent('click'));
    });
    await page.waitForFunction(() => !document.getElementById('generatePairingButton').disabled);
    assert.equal(pairingCalls - before, 1);
    delay = 0;
  });
  await t.test('codigo e instrucoes aparecem, atualizacao do painel preserva o codigo', async () => {
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => !document.getElementById('pairingCodeValue').hidden);
    assert.equal(await page.$eval('#pairingCodeValue', (element) => element.textContent), 'ABCD-1234');
    assert.equal(await page.$eval('#pairingInstructions', (element) => element.hidden), false);
    assert.equal(await page.$eval('#copyPairingCodeButton', (element) => element.hidden), false);
    await page.evaluate(() => carregarPainelBarbeiro());
    assert.equal(await page.$eval('#pairingCodeValue', (element) => element.hidden), false);
    assert.equal(await page.$eval('#generatePairingButton', (element) => element.disabled), false);
  });
  await t.test('polling detecta conexao, oculta codigo e para', async () => {
    connected = true;
    await page.waitForFunction(() => document.getElementById('generatePairingButton').textContent === 'WhatsApp conectado', { timeout: 20000 });
    assert.equal(await page.evaluate(() => whatsappPolling), null);
    assert.equal(await page.$eval('#pairingCodeValue', (element) => element.hidden), true);
    assert.equal(await page.$eval('#generatePairingButton', (element) => element.disabled), true);
  });
  await t.test('recarregar a pagina recupera WhatsApp conectado', async () => {
    await page.reload();
    await page.waitForFunction(() => document.getElementById('generatePairingButton').textContent === 'WhatsApp conectado');
    assert.equal(await page.$eval('#pairingCodeValue', (element) => element.hidden), true);
    await page.type('#whatsappPairingNumber', '75983179933');
  });
  await t.test('desconectar e conectar usando QR pelo painel', async () => {
    await page.click('#disconnectWhatsappButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('WhatsApp desconectado'));
    await page.click('#generateQrButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('escaneie'));
    assert.equal(await page.$eval('#pairingCodeValue', (element) => element.hidden), true);
    await page.click('#disconnectWhatsappButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('WhatsApp desconectado'));
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => !document.getElementById('pairingCodeValue').hidden);
  });
  await t.test('falha exibe message e libera botao', async () => {
    connected = false;
    pairingError = true;
    await page.evaluate(() => atualizarStatusWhatsapp('disconnected'));
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('Nao foi possivel gerar'));
    assert.equal(await page.$eval('#generatePairingButton', (element) => element.disabled), false);
    assert.equal(await page.evaluate(() => whatsappPolling), null);
  });
  await t.test('timeout libera botao mesmo sem resposta', async () => {
    pairingError = false;
    delay = 150;
    await page.evaluate(() => {
      const original = window.setTimeout;
      window.setTimeout = (callback, ms, ...args) => original(callback, ms === 70000 ? 30 : ms, ...args);
    });
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('demorou'));
    assert.equal(await page.$eval('#generatePairingButton', (element) => element.disabled), false);
  });
  await t.test('tres falhas de status param consultas automaticas', async () => {
    statusError = true;
    await page.evaluate(async () => {
      whatsappStatusPaused = false;
      whatsappPollingErrors = 0;
      await consultarStatusWhatsapp();
      await consultarStatusWhatsapp();
      await consultarStatusWhatsapp();
    });
    assert.equal(await page.evaluate(() => whatsappStatusPaused), true);
    assert.equal(await page.evaluate(() => whatsappPolling), null);
  });
  await t.test('refresh geral nao consulta status e sair da secao cancela polling', async () => {
    const before = statusCalls;
    await page.evaluate(() => carregarPainelBarbeiro());
    assert.equal(statusCalls, before);
    await page.evaluate(() => { whatsappStatusPaused = false; iniciarPollingWhatsapp(); setActiveSection('servicos'); });
    assert.equal(await page.evaluate(() => whatsappPolling), null);
    await page.evaluate(() => setActiveSection('inicio'));
  });
  await t.test('429 mostra contagem e impede cliques ate expirar', async () => {
    rateLimited = true;
    await page.click('#generatePairingButton');
    await page.waitForFunction(() => document.getElementById('qrStatusMessage').textContent.includes('segundos'));
    assert.equal(await page.$eval('#generatePairingButton', e => e.disabled), true);
    assert.match(await page.$eval('#whatsappStatusBadge', e => e.textContent), /^Aguardando nova tentativa \(\d+s\)$/);
    await page.evaluate(() => { whatsappCooldownUntil -= 5000; atualizarCooldownWhatsapp(); });
    assert.match(await page.$eval('#whatsappStatusBadge', e => e.textContent), /\(5[0-5]s\)/);
    const before = pairingCalls;
    await page.evaluate(() => solicitarPairingCode());
    assert.equal(pairingCalls, before);
    assert.equal(await page.evaluate(() => whatsappPolling), null);
    await page.evaluate(() => { whatsappCooldownUntil = Date.now() - 1; atualizarCooldownWhatsapp(); });
    assert.equal(await page.$eval('#generatePairingButton', e => e.disabled), false);
    rateLimited = false;
  });
  await t.test('pagehide encerra polling sem novas chamadas', async () => {
    const before = statusCalls;
    await page.evaluate(() => {
      whatsappStatusPaused = false;
      iniciarPollingWhatsapp();
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });
    assert.equal(await page.evaluate(() => whatsappPolling), null);
    assert.equal(statusCalls, before);
  });
  await t.test('prazo e limite de tentativas encerram polling antes de consultar', async () => {
    const before = statusCalls;
    for (const limit of ['deadline', 'attempts']) {
      const result = await page.evaluate(async limit => {
        const original = window.setTimeout;
        let tick;
        window.setTimeout = (fn, ms, ...args) => ms === 15000 ? (tick = fn, 0) : original(fn, ms, ...args);
        whatsappStatusPaused = false;
        iniciarPollingWhatsapp();
        window.setTimeout = original;
        if (limit === 'deadline') whatsappPollingDeadline = Date.now() - 1;
        else whatsappPollingAttempts = 12;
        await tick();
        return { paused: whatsappStatusPaused, polling: whatsappPolling };
      }, limit);
      assert.deepEqual(result, { paused: true, polling: null });
    }
    assert.equal(statusCalls, before);
  });
  await t.test('erro definitivo para na primeira consulta e 429 de status aplica cooldown', async () => {
    statusError = true;
    statusErrorCode = 'EVOLUTION_INVALID_KEY';
    await page.evaluate(async () => { whatsappStatusPaused = false; await consultarStatusWhatsapp(); });
    assert.equal(await page.evaluate(() => whatsappStatusPaused), true);
    statusHttp = 429;
    statusErrorCode = 'EVOLUTION_RATE_LIMIT';
    await page.evaluate(async () => { whatsappStatusPaused = false; await consultarStatusWhatsapp(); });
    assert.equal(await page.$eval('#generatePairingButton', e => e.disabled), true);
    assert.match(await page.$eval('#qrStatusMessage', e => e.textContent), /45 segundos/);
    statusHttp = 503;
    statusError = false;
    await page.evaluate(() => { whatsappCooldownUntil = Date.now() - 1; atualizarCooldownWhatsapp(); });
  });
  await t.test('aba oculta suspende polling e bloqueia consultas', async () => {
    const before = statusCalls;
    await page.evaluate(async () => {
      whatsappStatusPaused = false;
      iniciarPollingWhatsapp();
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await consultarStatusWhatsapp();
    });
    assert.equal(await page.evaluate(() => whatsappPolling), null);
    assert.equal(statusCalls, before);
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  });
  assert.deepEqual(errors, []);
});
