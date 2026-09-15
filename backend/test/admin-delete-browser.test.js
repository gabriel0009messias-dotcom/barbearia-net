const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));

test('listagem atualiza apos aprovacao e permite liberar cadastro oculto por email', { skip: !executablePath }, async t => {
  const app = express();
  app.use(express.json());
  let rows = [];
  let grants = 0;
  let listRequests = 0;
  app.get('/api/admin/assinatura-config', (req, res) => res.json({}));
  app.get('/api/admin/assinaturas', (req, res) => { listRequests++; res.json(rows); });
  app.get('/api/admin/assinaturas/por-email', (req, res) => {
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    assert.equal(req.query.email, 'hidden@example.test');
    res.json({ id: 9, email: 'hidden@example.test', barbearia_nome: 'Cliente oculto' });
  });
  app.post('/api/admin/assinaturas/9/liberar-dias', (req, res) => {
    grants++;
    assert.equal(req.body.dias, 2);
    const ate = new Date(Date.now() + 2 * 86400000).toISOString();
    rows.push({ id: 9, email: 'hidden@example.test', barbearia_nome: 'Cliente oculto', status: 'ativa', acesso_manual_ate: ate });
    res.json({ sucesso: true, id: 9, acesso_manual_ate: ate });
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('admin_token_salaoflix', 'fake-admin-session');
    const original = window.setInterval;
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 30000) { window.refreshAdminForTest = callback; return 0; }
      return original(callback, delay, ...args);
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/controle-interno.html`);
  await page.waitForFunction(() => document.querySelector('#adminResumo').textContent.startsWith('0 assinaturas'));
  assert.equal(await page.$eval('#adminAssinaturasBody', node => node.textContent.includes('Cliente oculto')), false);
  await page.type('#adminSuporteInput', '5511999999999');
  rows.push({ id: 1, barbearia_nome: 'Cliente pago', status: 'ativa' });
  await page.evaluate(() => window.refreshAdminForTest());
  await page.waitForFunction(() => document.querySelector('#adminResumo').textContent.startsWith('1 assinaturas'));
  assert.match(await page.$eval('#adminAssinaturasBody', node => node.textContent), /Cliente pago/);
  assert.equal(await page.$eval('#adminSuporteInput', node => node.value), '5511999999999');
  await page.type('#adminLiberacaoEmail', 'hidden@example.test');
  await page.$eval('#adminLiberacaoDias', node => { node.value = '2'; });
  page.once('dialog', dialog => dialog.dismiss());
  await page.click('#adminLiberacaoForm button');
  await page.waitForFunction(() => document.querySelector('#adminLiberacaoMessage').textContent.includes('cancelada'));
  assert.equal(grants, 0);
  page.once('dialog', dialog => dialog.accept());
  await page.click('#adminLiberacaoForm button');
  await page.waitForFunction(() => document.querySelector('#adminResumo').textContent.startsWith('2 assinaturas'));
  assert.equal(grants, 1);
  assert.match(await page.$eval('#adminAssinaturasBody', node => node.textContent), /Cliente oculto/);
  await page.select('.status-select', 'bloqueado');
  const before = listRequests;
  await page.evaluate(() => window.refreshAdminForTest());
  assert.equal(listRequests, before, 'atualizacao automatica preserva alteracao de status nao salva');
});

test('botao Excluir: confirmacao, erro e linha correta', { skip: !executablePath }, async t => {
  const app = express();
  app.use(express.json());
  let rows = [1, 2].map(id => ({ id, barbearia_nome: id === 1 ? '<img src=x onerror=alert(1)>' : 'Outra conta', status: 'pendente', deleteConfirmationToken: `confirm-${id}` }));
  let requests = 0;
  let fail = false;
  let grants = 0;
  app.get('/api/admin/assinatura-config', (req, res) => res.json({}));
  app.get('/api/admin/assinaturas', (req, res) => res.json(rows));
  app.post('/api/admin/assinaturas/:id/liberar-dias', (req, res) => {
    grants++;
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    assert.equal(req.params.id, '1');
    assert.equal(req.body.dias, 3);
    const ate = new Date(Date.now() + 3 * 86400000).toISOString();
    rows[0] = { ...rows[0], status: 'ativa', acesso_manual_ate: ate };
    res.json({ sucesso: true, id: 1, acesso_manual_ate: ate });
  });
  app.delete('/api/admin/assinaturas/:id', (req, res) => {
    requests++;
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    assert.equal(req.params.id, '1');
    assert.equal(req.body.confirmationToken, 'confirm-1');
    if (fail) return res.status(500).json({ error: 'Nao foi possivel excluir a conta.' });
    rows = rows.filter(row => row.id !== 1);
    res.json({ sucesso: true, id: 1 });
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => localStorage.setItem('admin_token_salaoflix', 'fake-admin-session'));
  await page.goto(`http://127.0.0.1:${server.address().port}/controle-interno.html`);
  await page.waitForSelector('.delete-account');
  assert.equal(await page.$$eval('#adminAssinaturasBody img', nodes => nodes.length), 0);
  await t.test('liberar dias permite cancelar, valida o prazo e atualiza status e resumo', async () => {
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('.grant-days');
    await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(grants, 0);
    page.once('dialog', dialog => dialog.accept('0'));
    await page.click('.grant-days');
    await page.waitForFunction(() => document.querySelector('#adminTableMessage').textContent.includes('1 a 365'));
    assert.equal(grants, 0);
    page.once('dialog', dialog => dialog.accept('3'));
    await page.click('.grant-days');
    await page.waitForFunction(() => document.querySelector('#adminAssinaturasBody').textContent.includes('Acesso gratuito ate'));
    assert.equal(grants, 1);
    assert.equal(await page.$eval('.status-select', node => node.value), 'ativo');
    assert.match(await page.$eval('#adminResumoLista', node => node.textContent), /Ativos:\s*1/);
    await page.click('#adminAssinaturasBody button');
    await page.waitForFunction(() => document.querySelector('#adminTableMessage').textContent.includes('ja esta ativa'));
  });
  await t.test('cancelar nao envia DELETE e preserva a linha', async () => {
    page.once('dialog', async dialog => {
      assert.equal(dialog.message(), 'Tem certeza que deseja excluir esta conta? Esta ação não poderá ser desfeita.');
      await dialog.dismiss();
    });
    await page.click('.delete-account');
    await page.waitForNetworkIdle({ idleTime: 100 });
    assert.equal(requests, 0);
    assert.equal(await page.$$eval('#adminAssinaturasBody tr', nodes => nodes.length), 2);
  });
  await t.test('erro exibe mensagem e mantem linha e botao utilizavel', async () => {
    fail = true;
    page.once('dialog', dialog => dialog.accept());
    await page.click('.delete-account');
    await page.waitForFunction(() => document.querySelector('#adminTableMessage').textContent.includes('Nao foi possivel'));
    assert.equal(await page.$$eval('#adminAssinaturasBody tr', nodes => nodes.length), 2);
    assert.equal(await page.$eval('.delete-account', button => button.disabled), false);
  });
  await t.test('confirmar remove somente a conta selecionada e atualiza resumo', async () => {
    fail = false;
    page.once('dialog', dialog => dialog.accept());
    await page.click('.delete-account');
    await page.waitForFunction(() => document.querySelector('#adminResumo').textContent.startsWith('1 assinaturas'));
    assert.equal(await page.$$eval('#adminAssinaturasBody tr', nodes => nodes.length), 1);
    assert.match(await page.$eval('#adminAssinaturasBody', node => node.textContent), /Outra conta/);
    assert.equal(requests, 2);
  });
});
