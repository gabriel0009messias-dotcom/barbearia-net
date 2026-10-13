const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const puppeteer = require('puppeteer');
const publicPath = path.resolve(__dirname, '../public');
const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));

test('conteudo publico e frontend legado nao incluem credenciais administrativas fixas', () => {
  const html = fs.readFileSync(path.join(publicPath, 'controle-interno.html'), 'utf8');
  for (const id of ['adminEmailInput', 'adminSenhaInput']) {
    const input = html.match(new RegExp('<input\\b[^>]*id="' + id + '"[^>]*>'));
    assert.ok(input); assert.doesNotMatch(input[0], /value="[^"]+"/);
  }
  const files = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file); else if (/\.(html|js|css|json|map)$/.test(file)) files.push(file);
    }
  }
  walk(publicPath); walk(path.resolve(__dirname, '../../painel-admin'));
  files.push(path.resolve(__dirname, '../app.js'));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /(?:ADMIN_(?:EMAIL|SENHA|PASSWORD)|adminToken)\s*=\s*['"][^'"]+['"]/, path.basename(file));
    assert.doesNotMatch(text, /(?:localStorage|sessionStorage)\.setItem\([^\n]*(?:admin.*token|token.*admin)/i, path.basename(file));
  }
});

test('Admin exige digitacao, limpa campos e nao persiste segredo ou token no navegador', { skip: !executablePath }, async t => {
  const email = `synthetic-${crypto.randomUUID()}@example.test`, password = crypto.randomUUID(), token = crypto.randomUUID();
  const app = express(); app.use(express.json());
  let attempts = 0, lists = 0, revoked = false;
  app.post('/api/admin/login', (req, res) => {
    attempts++; assert.equal(req.body.email, email); assert.equal(req.body.senha, password);
    assert.equal(Object.keys(req.query).length, 0); res.set('Cache-Control', 'no-store').json({ token });
  });
  app.get('/api/admin/assinatura-config', (req, res) => { assert.equal(req.headers['x-admin-token'], token); res.json({}); });
  app.get('/api/admin/assinaturas', (req, res) => { lists++; assert.equal(req.headers['x-admin-token'], token); res.json({ assinaturas: [], pendentes: [] }); });
  app.post('/api/admin/logout', (req, res) => { assert.equal(req.headers['x-admin-token'], token); revoked = true; res.json({ sucesso: true }); });
  app.use(express.static(publicPath));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const page = await browser.newPage(), logs = [], urls = [];
  page.on('console', event => logs.push(event.text())); page.on('pageerror', error => logs.push(error.message));
  page.on('request', request => urls.push(request.url()));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base + '/controle-interno.html');
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#adminEmailInput').value, document.querySelector('#adminSenhaInput').value]), ['', '']);
  assert.equal(attempts, 0); assert.equal(lists, 0);
  await page.evaluate(() => { localStorage.setItem('admin_token_salaoflix', 'synthetic-old-token'); localStorage.setItem('barbearia_admin_token', 'synthetic-old-token'); localStorage.setItem('admin_token_salaoflix_inline', 'synthetic-old-token'); });
  await page.reload(); assert.equal(await page.evaluate(() => localStorage.length), 0); assert.equal(lists, 0);
  for (const file of fs.readdirSync(publicPath).filter(file => /\.(html|js|css)$/.test(file))) {
    const response = await fetch(base + '/' + file), body = await response.text();
    assert.equal(response.status, 200);
    for (const value of [email, password, token]) assert.equal(body.includes(value), false, file);
  }
  await page.type('#adminEmailInput', email); await page.type('#adminSenhaInput', password);
  await page.click('#adminLoginForm button'); await page.waitForFunction(() => !document.querySelector('#adminPanel').hidden && document.querySelector('#adminSenhaInput').value === '');
  assert.equal(attempts, 1); assert.ok(lists > 0);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  for (const secret of [password, token]) {
    assert.equal(storage.includes(secret), false); assert.equal(logs.join('\n').includes(secret), false);
    assert.equal(urls.some(url => url.includes(secret)), false);
    assert.equal(await page.evaluate(secret => document.documentElement.outerHTML.includes(secret), secret), false);
  }
  await page.click('#sairAdminButton'); await page.waitForFunction(() => !document.querySelector('#adminLoginCard').hidden);
  assert.equal(revoked, true);
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#adminEmailInput').value, document.querySelector('#adminSenhaInput').value]), ['', '']);
  await page.reload(); assert.equal(attempts, 1);
});
