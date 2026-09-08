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
  let delay = 0;
  const app = express();
  app.use(express.json());
  app.get('/api/publico/assinatura-config', (_, res) => res.json({ whatsappEnabled: true }));
  app.get('/api/barbeiro/me', (_, res) => res.json({ id: 1, status: 'ativo', servicos: [] }));
  app.get('/api/faturamento', (_, res) => res.json({ total: 0 }));
  app.get(['/api/agendamentos', '/api/bloqueios'], (_, res) => res.json([]));
  app.get('/api/publico/assinaturas/1/whatsapp/status', (_, res) => statusError
    ? res.status(503).json({ success: false, message: 'Servidor do WhatsApp indisponivel.' })
    : res.json({ success: true, connected, status: connected ? 'connected' : 'pairing' }));
  app.post('/api/publico/assinaturas/1/whatsapp/pairing-code', async (req, res) => {
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
  app.use(express.static(path.resolve(__dirname, '../../painel')));
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
    await page.waitForFunction(() => document.getElementById('generatePairingButton').textContent === 'WhatsApp conectado', { timeout: 10000 });
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
  assert.deepEqual(errors, []);
});
