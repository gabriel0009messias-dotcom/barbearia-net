const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));

test('pendentes no navegador: dados, liberacao, exclusao e atualizacao apos pagamento', { skip: !executablePath }, async t => {
  const app = express();
  app.use(express.json());
  const assinaturas = [];
  let pendentes = [1, 2, 3].map(id => ({ id, barbearia_nome: `Salao ${id}`, responsavel_nome: '<img src=x onerror=alert(1)>',
    email: `pending${id}@example.test`, whatsapp_numero: '5511999999999', metodo_pagamento: 'mercado_pago',
    status: 'aguardando_pagamento', created_at: id === 2 ? null : '2026-09-15T12:00:00Z', deleteConfirmationToken: `confirm-${id}` }));
  let grants = 0;
  let deletes = 0;
  let rejectDelete = false;
  const move = id => {
    const account = pendentes.find(row => row.id === id);
    pendentes = pendentes.filter(row => row.id !== id);
    assinaturas.push({ ...account, status: 'ativa' });
  };
  app.get('/api/admin/assinatura-config', (req, res) => res.json({}));
  app.get('/api/admin/assinaturas', (req, res) => {
    assert.equal(req.query.incluirPendentes, '1');
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    res.json({ assinaturas, pendentes });
  });
  app.post('/api/admin/assinaturas/1/liberar-dias', (req, res) => {
    grants++;
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    assert.equal(req.body.dias, 2);
    move(1);
    res.json({ sucesso: true, id: 1, acesso_manual_ate: new Date(Date.now() + 2 * 86400000).toISOString() });
  });
  app.delete('/api/admin/assinaturas/2', (req, res) => {
    deletes++;
    assert.equal(req.headers['x-admin-token'], 'fake-admin-session');
    assert.equal(req.body.confirmationToken, 'confirm-2');
    if (rejectDelete) return res.status(500).json({ error: 'Falha simulada ao excluir.' });
    pendentes = pendentes.filter(row => row.id !== 2);
    res.json({ sucesso: true, id: 2 });
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
  await page.waitForSelector('#adminPendentesBody .grant-days');
  await t.test('pendentes separados, campos seguros, data opcional e sem controle de status', async () => {
    assert.equal(await page.$$eval('#adminAssinaturasBody .grant-days', nodes => nodes.length), 0);
    assert.equal(await page.$$eval('#adminPendentesBody tr', nodes => nodes.length), 3);
    assert.equal(await page.$$eval('#adminPendentesBody img, #adminPendentesBody select', nodes => nodes.length), 0);
    const values = await page.$$eval('#adminPendentesBody tr:first-child td', nodes => nodes.map(node => node.textContent));
    assert.deepEqual(values.slice(0, 6), ['Salao 1', '<img src=x onerror=alert(1)>', 'pending1@example.test', '5511999999999', 'Mercado Pago', 'Aguardando pagamento']);
    assert.match(values[6], /15\/09\/2026/);
    assert.equal(await page.$eval('#adminPendentesBody tr:nth-child(2) td:nth-child(7)', node => node.textContent), '--');
  });
  await t.test('liberar move somente o cadastro selecionado para a lista principal', async () => {
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#adminPendentesBody .grant-days');
    assert.equal(grants, 0);
    page.once('dialog', dialog => dialog.accept('2'));
    await page.click('#adminPendentesBody .grant-days');
    await page.waitForFunction(() => document.querySelector('#adminAssinaturasBody').textContent.includes('Salao 1'));
    assert.equal(grants, 1);
    assert.equal(await page.$eval('#adminPendentesBody', node => node.textContent.includes('Salao 1')), false);
    assert.match(await page.$eval('#adminPendentesMessage', node => node.textContent), /Acesso liberado/);
  });
  await t.test('exclusao pode ser cancelada, erro preserva cadastro e sucesso remove so o escolhido', async () => {
    page.once('dialog', dialog => dialog.dismiss());
    await page.click('#adminPendentesBody .delete-account');
    assert.equal(deletes, 0);
    rejectDelete = true;
    page.once('dialog', dialog => dialog.accept());
    await page.click('#adminPendentesBody .delete-account');
    await page.waitForFunction(() => document.querySelector('#adminPendentesMessage').textContent.includes('Falha simulada'));
    assert.equal(await page.$eval('#adminPendentesBody .delete-account', node => node.disabled), false);
    assert.match(await page.$eval('#adminPendentesBody', node => node.textContent), /Salao 2/);
    rejectDelete = false;
    page.once('dialog', dialog => dialog.accept());
    await page.click('#adminPendentesBody .delete-account');
    await page.waitForFunction(() => !document.querySelector('#adminPendentesBody').textContent.includes('Salao 2'));
    assert.equal(deletes, 2);
    assert.match(await page.$eval('#adminAssinaturasBody', node => node.textContent), /Salao 1/);
  });
  await t.test('atualizacao automatica move cadastro apos aprovacao sem duplicar', async () => {
    move(3);
    await page.evaluate(() => window.refreshAdminForTest());
    await page.waitForFunction(() => document.querySelector('#adminAssinaturasBody').textContent.includes('Salao 3'));
    assert.equal(await page.$$eval('#adminAssinaturasBody .grant-days', nodes => nodes.length), 2);
    assert.match(await page.$eval('#adminPendentesBody', node => node.textContent), /Nenhum cadastro aguardando pagamento/);
  });
});
