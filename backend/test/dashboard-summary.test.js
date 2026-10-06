const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { financialSummary } = require('../services/finance');
const { appointmentPermissions, localMoment } = require('../services/agenda');

test('Dashboard etapa 2: indicadores reais, períodos, estados vazios e responsividade', { timeout: 60000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath);
  const now = new Date('2026-10-15T15:00:00Z'), moment = localMoment(now);
  const booking = (id, data, status, preco, serviceId, name = `Cliente ${id}`, hora = '09:00') => ({
    id, data, status, preco, hora, nome_cliente: name, telefone: `119999900${String(id).padStart(2, '0')}`,
    servico_nome: `Serviço ${serviceId}`, studio_service_id: serviceId, profissional: 'Ana', profissional_id: 1,
  });
  const rows = [booking(1, '2026-10-15', 'concluido', 30.1, 1),
    booking(2, '2026-10-15', 'concluido', 20.2, 1),
    booking(3, '2026-10-12', 'concluido', 40, 2),
    booking(4, '2026-10-11', 'concluido', 50, 3),
    booking(5, '2026-09-30', 'concluido', 60, 4),
    booking(6, '2026-10-16', 'concluido', 999, 6),
    booking(7, '2026-10-15', 'concluido', 999, 7, 'Concluído futuro', '13:00'),
    booking(8, '2026-10-15', 'cancelado', 999, 8),
    booking(9, '2026-10-15', 'falta', 999, 9),
    booking(10, '2026-10-15', 'confirmado', 999, 10, 'Agendado anterior', '11:00'),
    booking(11, '2026-10-15', 'confirmado', 999, 11, 'Próximo hoje', '14:00'),
    ...Array.from({ length: 6 }, (_, i) => booking(20+i, '2026-10-16', 'confirmado', 30, 1,
      i === 0 ? '<img src=x onerror=alert(1)>' : `Próximo ${i}`, `${String(i+8).padStart(2,'0')}:00`)),
  ];
  rows[0].telefone = '+55 (11) 99999-0001'; rows[1].telefone = '5511999990001';
  const professionals = [{ id: 1, nome: 'Ana', ativo: true }, { id: 2, nome: 'Bia', ativo: true }, { id: 3, nome: 'Caio', ativo: false }];
  let empty = false, activeSubscription = false;
  const app = express();
  app.get('/api/barbeiro/me', (_req, res) => res.json({ id: 1, barbearia_nome: 'Studio teste',
    acesso: { liberado: true, status: activeSubscription ? 'subscription_active' : 'trial_active',
      trial: { endsAt: '2026-10-17T15:00:00Z', daysRemaining: 2 } } }));
  app.get('/api/studiofy/painel', (_req, res) => {
    const appointments = empty ? [] : rows;
    res.json({ pagina: { slug: 'studio-test' }, agenda: { hoje: moment.date },
      agendamentos: appointments.map(a => ({ ...a, ...appointmentPermissions(a, moment) })),
      profissionais: empty ? [] : professionals, servicos: [], bloqueios: [], lembretes: [],
      financeiro: financialSummary(appointments, now) });
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().includes('/api/chat') || !request.url().startsWith(base)) {
      return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    }
    request.continue();
  });
  await page.emulateTimezone('Asia/Tokyo');
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(base + '/studiofy.html');
  await page.waitForSelector('#dashboardStatus[data-state=ready]');
  const metric = key => page.$eval(`[data-dashboard="${key}"] .stat`, el => el.textContent);
  await t.test('quatro cards: hoje operacional, clientes e receita diária/mensal', async () => {
    assert.equal(await page.$$eval('.dashboard-metrics .metric', els => els.length), 4);
    assert.equal(await metric('today'), '4');
    assert.equal(await metric('clients'), '4');
    assert.match(await metric('revenue-today'), /50,30/);
    assert.match(await metric('revenue-month'), /140,30/);
    assert.match(await page.$eval('[data-dashboard=today]', el => el.textContent), /15\/10\/2026/);
  });
  await t.test('resumo financeiro usa hoje, segunda-feira e mês sem somar outros status', async () => {
    for (const [period, amount] of [['hoje', '50,30'], ['semana', '90,30'], ['mes', '140,30']]) {
      assert.ok((await page.$eval(`[data-dashboard-period=${period}]`, el => el.textContent)).includes(amount));
    }
    assert.match(await page.$eval('[data-dashboard-period=semana]', el => el.textContent), /12\/10\/2026.*segunda-feira/);
    assert.match(await page.$eval('[data-dashboard-period=mes]', el => el.textContent), /01\/10\/2026/);
  });
  await t.test('todos os status referem-se a hoje; futuros concluídos ficam de fora', async () => {
    for (const [status, value] of [['confirmado','2'],['concluido','2'],['cancelado','1'],['falta','1']]) {
      assert.equal(await page.$eval(`[data-dashboard-status=${status}] dd`, el => el.textContent), value);
    }
    assert.match(await page.$eval('#todayStatusTitle', el => el.parentElement.textContent), /Hoje.*15\/10\/2026/);
  });
  await t.test('próximos: ordenados, até cinco, com horário, cliente, serviço e profissional', async () => {
    const upcoming = await page.$$eval('.appointment-summary', els => els.map(el => el.textContent));
    assert.equal(upcoming.length, 5);
    assert.match(upcoming[0], /Próximo hoje.*Serviço 11.*Ana.*14:00/);
    assert.match(upcoming[1], /08:00/); assert.match(upcoming[4], /11:00/);
    assert.ok(!upcoming.join(' ').includes('Agendado anterior'));
    assert.ok(!upcoming.join(' ').includes('Concluído futuro'));
    assert.equal(await page.$('.appointment-summary img'), null, 'Nome do cliente é escapado');
  });
  await t.test('ranking histórico só inclui concluídos válidos; profissionais ativos e trial', async () => {
    const ranking = await page.$$eval('.dashboard-ranking li', els => els.map(el => el.textContent));
    assert.equal(ranking.length, 3);
    assert.match(ranking[0], /Serviço 1.*2 atendimento/);
    assert.ok(!ranking.join(' ').match(/Serviço [6789]/));
    assert.match(await page.$eval('[data-dashboard-professionals]', el => el.textContent), /2.*de 3 cadastrado/);
    assert.match(await page.$eval('[data-dashboard-subscription]', el => el.textContent), /Teste grátis ativo/);
    assert.equal(await page.$$eval('#trialBanner', els => els.length), 1);
    assert.match(await page.$eval('#trialBanner', el => el.textContent), /2 dia\(s\) restantes/);
  });
  await t.test('desktop e mobile sem transbordamento, mesmo com nomes longos', async () => {
    const artifacts = path.resolve(__dirname, '../../.tmp/dashboard-stage2-preview');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const width of [1440, 390, 320]) {
      await page.setViewport({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `largura ${width}`);
      await page.screenshot({ path: path.join(artifacts, `dashboard-${width}.png`), fullPage: true });
    }
  });
  await t.test('assinatura ativa discreta e estabelecimento vazio sem valores inventados', async () => {
    activeSubscription = true; empty = true; await page.evaluate(() => action(refresh));
    assert.equal(await metric('today'), '0'); assert.equal(await metric('clients'), '0');
    assert.match(await metric('revenue-today'), /0,00/); assert.match(await metric('revenue-month'), /0,00/);
    assert.match(await page.$eval('#view', el => el.textContent), /Nenhum atendimento concluído ainda/);
    assert.match(await page.$eval('.upcoming', el => el.textContent), /Nenhum próximo agendamento/);
    assert.equal(await page.$('.dashboard-ranking'), null);
    assert.match(await page.$eval('[data-dashboard-professionals]', el => el.textContent), /0.*de 0 cadastrado/);
    assert.match(await page.$eval('[data-dashboard-subscription]', el => el.textContent), /Assinatura ativa/);
    assert.equal(await page.$eval('#trialBanner', el => el.hidden), true);
  });
  assert.deepEqual(errors, []);
});
