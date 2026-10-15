const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');

test('Rebranding: cadastro alternativo retorna mensagem neutra e preserva validação e HTTP 400', async t => {
  const { createApp } = require('../src/app');
  const authService = require('../src/services/saasAuthService');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const payload of [{}, { salonName: null }, { salonName: '' },
    { salonName: '   ' }, { salonName: '\t\n' }, { salonName: 0 },
    { salonName: false }, { salonName: [] }]) {
    await assert.rejects(authService.register(payload), error =>
      error.statusCode === 400 && error.message === 'Nome do estabelecimento é obrigatório.');
    const response = await fetch(base + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 400);
    // Preserve the public sanitization policy published in af871c77.
    assert.deepEqual(await response.json(), { error: 'Erro interno no servico. Tente novamente.' });
  }
  // A nonempty establishment name must still advance to the existing next validation.
  await assert.rejects(authService.register({ salonName: 'Studio Ana' }), error =>
    error.statusCode === 400 && error.message === 'Nome do administrador e obrigatorio.');
  const unexpected = new Error('Synthetic conversion failure');
  await assert.rejects(authService.register({ salonName: { toString() { throw unexpected; } } }),
    error => error === unexpected, 'Unexpected errors retain their identity and message');
});

test('Rebranding: falha de carregamento aparece no HTML real do painel em desktop e mobile', { timeout: 60000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(file => file && fs.existsSync(file));
  assert.ok(executablePath, 'Chrome necessário para validar a mensagem no DOM real');
  const publicPath = path.resolve(__dirname, '../public');
  const app = express();
  let failureStatus = 503;
  app.get('/api/publico/assinatura-config', (_req, res) =>
    res.status(failureStatus).json({ error: 'Falha sintética de carregamento' }));
  // Serve the shipped HTML unchanged: no synthetic message target is injected.
  app.use(express.static(publicPath));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [], apiRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().startsWith(base + '/api/')) apiRequests.push(new URL(request.url()).pathname);
    if (request.url().startsWith(base + '/') || request.url().startsWith('data:')) request.continue();
    else request.abort();
  });
  await page.evaluateOnNewDocument(() => {
    if (location.pathname === '/barbeiro.html') localStorage.setItem('barbearia_auth_token', 'synthetic-session');
  });
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000 });
    const response = await page.goto(base + '/barbeiro.html');
    assert.equal(await response.text(), fs.readFileSync(path.join(publicPath, 'barbeiro.html'), 'utf8'));
    await page.waitForFunction(() => document.querySelector('#formMessageInicio')?.textContent === 'Não foi possível carregar seu painel.');
    assert.equal(await page.$('#formMessage'), null);
    assert.ok(await page.$eval('#formMessageInicio', element => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    }), `${width}px: message is rendered in the existing page`);
    await page.click('#refreshButton');
    await page.waitForFunction(() => !document.querySelector('#refreshButton').disabled);
    assert.equal(await page.$eval('#formMessageInicio', element => element.textContent), 'Não foi possível carregar seu painel.');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px: no horizontal overflow`);
  }
  failureStatus = 401;
  await page.goto(base + '/barbeiro.html');
  await page.waitForFunction(() => location.pathname === '/login.html');
  assert.equal(await page.evaluate(() => localStorage.getItem('barbearia_auth_token')), null);
  assert.deepEqual(errors, []);
  assert.ok(apiRequests.length > 0);
  assert.ok(apiRequests.every(url => url === '/api/publico/assinatura-config'), 'Only the local configuration failure was requested');
});
