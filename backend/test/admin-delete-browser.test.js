const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));

test('botao Excluir: confirmacao, erro e linha correta', { skip: !executablePath }, async t => {
  const app = express();
  app.use(express.json());
  let rows = [1, 2].map(id => ({ id, barbearia_nome: id === 1 ? '<img src=x onerror=alert(1)>' : 'Outra conta', status: 'pendente', deleteConfirmationToken: `confirm-${id}` }));
  let requests = 0;
  let fail = false;
  app.get('/api/admin/assinatura-config', (req, res) => res.json({}));
  app.get('/api/admin/assinaturas', (req, res) => res.json(rows));
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
