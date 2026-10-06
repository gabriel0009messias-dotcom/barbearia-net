const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { financialSummary } = require('../services/finance');

test('Dashboard: clientes atendidos, fuso, carregamento, concorrência, falhas e retry', { timeout: 60000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath, 'Chrome necessário para testar o Dashboard');
  const app = express();
  const rows = [
    [1, '+55 (11) 99999-0000', 'concluido', '2026-09-28'],
    [2, '5511999990000', 'concluido', '2026-09-29'],
    [3, '(11) 99999-0000', 'concluido', '2026-09-30'],
    [4, '11999990001', 'cancelado', '2026-09-30'],
    [5, '11999990002', 'falta', '2026-09-30'],
    [6, '11999990003', 'confirmado', '2026-09-30'],
    [7, '11999990004', 'concluido', '2099-01-01'],
    [8, '11999990005', 'concluido', '2026-09-30'],
  ].map(([id, telefone, status, data]) => ({ id, telefone, status, data, hora: '09:00',
    nome_cliente: `Cliente ${id}`, servico_nome: 'Corte', studio_service_id: 1, profissional: 'Ana', preco: 30.1 }));
  const payload = () => ({ pagina: { nome: 'Studio teste', slug: 'studio-test' },
    agendamentos: rows, servicos: [], profissionais: [], bloqueios: [], lembretes: [],
    financeiro: financialSummary(rows, new Date('2026-10-04T15:00:00Z')) });
  let mode = 'ok', accountCalls = 0, panelCalls = 0, release;
  app.get('/api/barbeiro/me', async (_req, res) => {
    accountCalls++;
    if (mode === 'slow') await new Promise(resolve => { release = resolve; });
    if (mode === 'account-error') return res.status(503).json({ error: 'Falha temporária de teste.' });
    res.json({ id: 17, barbearia_nome: 'Studio teste', acesso: { liberado: true, status: 'trial_active',
      trial: { endsAt: '2026-10-05T00:00:00Z', daysRemaining: 1 } } });
  });
  app.get('/api/studiofy/painel', (_req, res) => {
    panelCalls++;
    if (mode === 'panel-error') return res.status(503).json({ error: 'Falha temporária de teste.' });
    res.json(payload());
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => {
    release?.(); await browser.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(() => localStorage.setItem('barbearia_auth_token', 'synthetic-dashboard-session'));
  await page.emulateTimezone('Asia/Tokyo');
  // No integrations or external network calls are permitted in this test.
  await page.setRequestInterception(true);
  const base = `http://127.0.0.1:${server.address().port}`;
  page.on('request', request => {
    if (request.url().includes('/api/chat') || request.url().includes('/api/publico/') || !request.url().startsWith(base)) {
      return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    }
    request.continue();
  });
  await t.test('loading inicial e uma atualização por vez', async () => {
    mode = 'slow'; await page.goto(base + '/studiofy.html');
    await page.waitForSelector('#dashboardStatus[data-state=loading]');
    assert.equal(await page.$eval('#view', el => el.getAttribute('aria-busy')), 'true');
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    const before = accountCalls;
    const pending = page.evaluate(() => Promise.all([refresh(), refresh(), refresh()]));
    await page.waitForFunction(() => document.querySelector('#dashboardStatus').dataset.state === 'loading');
    mode = 'ok'; release(); await pending;
    assert.equal(accountCalls, before);
    assert.equal(panelCalls, 1);
    await page.waitForSelector('#dashboardStatus[data-state=ready]');
  });
  await t.test('clientes normalizados, status e receita segura', async () => {
    assert.equal(await page.evaluate(() => normalizeClientPhone('+55 (11) 99999-0000')), '11999990000');
    assert.equal(await page.evaluate(() => normalizeClientPhone('5511999990000')), '11999990000');
    assert.equal(await page.evaluate(() => normalizeClientPhone('(11) 99999-0000')), '11999990000');
    assert.equal(await page.evaluate(() => normalizeClientPhone('5512345678')), '5512345678', 'DDD 55 não é código do país em telefone de dez dígitos');
    assert.equal(await page.evaluate(() => normalizeClientPhone('123')), '');
    const metrics = await page.$$eval('.metric .stat', els => els.map(el => el.textContent));
    assert.equal(metrics[1], '2');
    assert.match(metrics[2], /0,00/);
    assert.match(metrics[3], /0,00/);
    assert.match(await page.$eval('[data-dashboard-period=semana]', el => el.textContent), /120,40/);
    await page.click('[data-section="Clientes"]');
    assert.equal(await page.$$eval('#view tbody tr', rows => rows.length), 2);
    assert.match(await page.$eval('#view', el => el.textContent), /Cancelamentos, faltas/);
    await page.click('[data-section="Dashboard"]');
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  });
  await t.test('banner usa São Paulo mesmo com dispositivo no Japão', async () => {
    const banner = await page.$eval('#trialBanner', el => el.textContent);
    assert.match(banner, /04\/10\/2026,? 21:00:00/);
    assert.doesNotMatch(banner, /05\/10\/2026/);
  });
  await t.test('falha de atualização identifica os dados antigos e retry recupera', async () => {
    mode = 'panel-error'; await page.evaluate(() => action(refresh));
    assert.equal(await page.$eval('#dashboardStatus', el => el.dataset.state), 'error');
    assert.match(await page.$eval('#dashboardStatus', el => el.textContent), /desatualizados/);
    assert.equal(await page.$$eval('.metric', els => els.length), 4);
    assert.equal(await page.$eval('#view', el => el.getAttribute('aria-busy')), 'false');
    mode = 'ok'; await page.click('#retryDashboard');
    await page.waitForSelector('#dashboardStatus[data-state=ready]');
    assert.equal(await page.$('#retryDashboard'), null);
    assert.equal(await page.$eval('#message', el => el.textContent), '');
  });
  await t.test('falha inicial não inventa zeros e permite tentar novamente', async () => {
    mode = 'account-error'; await page.reload();
    await page.waitForSelector('#dashboardStatus[data-state=error]');
    assert.equal(await page.$$eval('.metric', els => els.length), 0);
    mode = 'ok'; await page.click('#retryDashboard');
    await page.waitForSelector('#dashboardStatus[data-state=ready]');
    assert.equal(await page.$$eval('.metric', els => els.length), 4);
  });
  await t.test('timeout libera a atualização para uma nova tentativa', async () => {
    mode = 'slow';
    // Accelerate only the request timeout; retain the real AbortController/fetch path.
    await page.evaluate(() => {
      window.originalAuditTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => window.originalAuditTimeout(fn, delay === 20000 ? 100 : delay, ...args);
    });
    await page.evaluate(() => action(refresh));
    assert.equal(await page.$eval('#dashboardStatus', el => el.dataset.state), 'error');
    assert.match(await page.$eval('#message', el => el.textContent), /demorou para responder/);
    await page.evaluate(() => { window.setTimeout = window.originalAuditTimeout; delete window.originalAuditTimeout; });
    release(); mode = 'ok';
    await page.click('#retryDashboard');
    await page.waitForSelector('#dashboardStatus[data-state=ready]');
    assert.equal(await page.$eval('#message', el => el.textContent), '');
  });
  assert.deepEqual(errors, []);
});
