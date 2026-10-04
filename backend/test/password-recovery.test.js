const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

test('Studiofy: recuperação via Resend, expiração e uso único no PostgreSQL', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  Object.assign(process.env, {
    NODE_ENV: 'test', RENDER: 'true', RESEND_API_KEY: 'synthetic-email-key',
    EMAIL_FROM: 'security@example.test', EMAIL_FROM_NAME: 'SalaoFlix',
    PUBLIC_APP_URL: 'https://studiofy.example.test',
    MERCADO_PAGO_ACCESS_TOKEN: '', MERCADO_PAGO_WEBHOOK_SECRET: '',
  });
  const db = require('../database');
  await db.ready;
  const app = express();
  app.use(express.json());
  app.use('/api', require('../routes'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const nativeFetch = global.fetch;
  const originalInfo = console.info;
  const originalError = console.error;
  const logs = [];
  const emails = [];
  let providerMode = 'ok';
  console.info = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.resend.com/emails', 'Nenhuma chamada externa real é permitida');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-email-key');
    const email = JSON.parse(options.body);
    emails.push(email);
    if (providerMode === 'failure') {
      // Simula um provedor que inclui o link sensível na mensagem de erro.
      const link = email.text.match(/https:\/\/\S+/)[0];
      return Response.json({ message: `Provider failure: ${link}` }, { status: 503 });
    }
    return Response.json({ id: `synthetic-message-${emails.length}` });
  };
  t.after(async () => {
    global.fetch = nativeFetch;
    console.info = originalInfo;
    console.error = originalError;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.close();
    await env.cleanup();
  });
  const api = async (route, body) => {
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const email = 'owner@example.test';
  const signup = await api('/publico/assinaturas', {
    barbeariaNome: 'Studio de teste', responsavelNome: 'Teste', telefone: '11999995678',
    email, senha: 'old-test-password', metodoPagamento: 'mercado_pago', diaVencimento: 5,
    servicos: [{ nome: 'Corte', preco: 30 }],
  });
  assert.equal(signup.status, 201);
  const id = signup.body.assinatura.id;
  const tokens = [];
  const links = [];
  const requestLink = async () => {
    const result = await api('/barbeiro/recuperar-senha/solicitar', { email });
    const link = emails.at(-1).text.match(/https:\/\/\S+/)[0];
    const token = new URL(link).searchParams.get('token');
    tokens.push(token);
    links.push(link);
    return { ...result, token };
  };
  const reset = token => api('/barbeiro/recuperar-senha/redefinir', {
    token, novaSenha: 'new-test-password', confirmarSenha: 'new-test-password',
  });
  let first;
  let current;
  await t.test('assunto, HTML, texto e remetente Studiofy; somente SHA-256 e validade de 60 minutos', async () => {
    const before = Date.now();
    first = await requestLink();
    assert.equal(first.status, 200);
    assert.match(first.body.mensagem, /Studiofy/);
    assert.equal(first.body.token, undefined);
    assert.equal(first.body.link, undefined);
    const sent = emails.at(-1);
    assert.equal(sent.subject, 'Recuperação de senha | Studiofy');
    assert.equal(sent.from, 'Studiofy <security@example.test>');
    assert.deepEqual(sent.to, [email]);
    assert.match(sent.text, /Studiofy/);
    assert.match(sent.html, /Studiofy/);
    assert.match(sent.html, /name="viewport"/);
    assert.match(sent.text, /60 minutos/);
    assert.doesNotMatch(JSON.stringify(sent), /sal[aã]o\s*flix/i);
    assert.match(first.token, /^[a-f0-9]{64}$/);
    const stored = await db.getAsync('SELECT * FROM password_reset_tokens WHERE assinatura_id=$1 AND used_at IS NULL', [id]);
    assert.equal(stored.token_hash, crypto.createHash('sha256').update(first.token).digest('hex'));
    assert.ok(!JSON.stringify(stored).includes(first.token));
    assert.ok(Date.parse(stored.expires_at) >= before + 60 * 60000);
    assert.ok(Date.parse(stored.expires_at) <= Date.now() + 60 * 60000);
    assert.equal((await api(`/barbeiro/recuperar-senha/token-status?token=${first.token}`)).status, 200);
  });
  await t.test('nova solicitação invalida o token anterior e mantém remetente padrão Studiofy', async () => {
    delete process.env.EMAIL_FROM_NAME;
    current = await requestLink();
    assert.equal(current.status, 200);
    assert.equal(emails.at(-1).from, 'Studiofy <security@example.test>');
    assert.notEqual(current.token, first.token);
    assert.equal((await reset(first.token)).status, 404);
  });
  await t.test('redefinição funciona e o token não pode ser reutilizado', async () => {
    const result = await reset(current.token);
    assert.equal(result.status, 200);
    assert.match(result.body.mensagem, /Studiofy/);
    const account = await db.getAsync('SELECT senha_hash,senha_salt FROM assinaturas WHERE id=$1', [id]);
    assert.equal(account.senha_hash, crypto.scryptSync('new-test-password', account.senha_salt, 64).toString('hex'));
    assert.equal((await reset(current.token)).status, 404);
    assert.equal((await api(`/barbeiro/recuperar-senha/token-status?token=${current.token}`)).status, 404);
  });
  await t.test('token expirado rejeita validação e redefinição sem alterar a senha', async () => {
    for (const action of ['status', 'reset']) {
      const expired = await requestLink();
      await db.runAsync('UPDATE password_reset_tokens SET expires_at=$1 WHERE assinatura_id=$2 AND used_at IS NULL', [new Date(Date.now() - 1000).toISOString(), id]);
      const before = await db.getAsync('SELECT senha_hash FROM assinaturas WHERE id=$1', [id]);
      const result = action === 'status'
        ? await api(`/barbeiro/recuperar-senha/token-status?token=${expired.token}`)
        : await reset(expired.token);
      assert.equal(result.status, 410);
      assert.deepEqual(await db.getAsync('SELECT senha_hash FROM assinaturas WHERE id=$1', [id]), before);
      assert.equal((await reset(expired.token)).status, 404);
    }
  });
  await t.test('falha do Resend não responde sucesso nem expõe o link/token nos logs', async () => {
    providerMode = 'failure';
    const result = await requestLink();
    assert.equal(result.status, 503);
    assert.equal(result.body.ok, undefined);
    assert.ok(!JSON.stringify(result.body).includes(result.token), 'Erro público não contém token');
    const output = JSON.stringify(logs);
    assert.ok(logs.some(args => String(args[0]).includes('envio concluido')));
    assert.ok(logs.some(args => String(args[0]).includes('falha ao solicitar link')));
    for (const token of tokens) assert.ok(!output.includes(token), 'Token ausente dos logs');
    for (const link of links) assert.ok(!output.includes(link), 'Link ausente dos logs');
    assert.ok(!output.includes('synthetic-email-key'), 'Credencial ausente dos logs');
  });
});

test('formulários de recuperação e redefinição funcionam no navegador', async t => {
  const puppeteer = require('puppeteer');
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath, 'Chrome disponível para validar os formulários');
  const app = express();
  app.use(express.json());
  let fail = false;
  let recoveryBody;
  let resetBody;
  app.post('/api/barbeiro/recuperar-senha/solicitar', (req, res) => {
    recoveryBody = req.body;
    if (fail) return res.status(503).json({ error: 'Serviço temporariamente indisponível.' });
    res.json({ mensagem: 'Enviamos um link de recuperação da sua conta Studiofy para o seu e-mail.' });
  });
  app.get('/api/barbeiro/recuperar-senha/token-status', (_req, res) => {
    if (fail) return res.status(410).json({ error: 'Esse link de recuperação expirou.' });
    res.json({ email: 'owner@example.test' });
  });
  app.post('/api/barbeiro/recuperar-senha/redefinir', (req, res) => {
    resetBody = req.body;
    res.json({ mensagem: 'Senha da sua conta Studiofy atualizada com sucesso.' });
  });
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await t.test('recuperação em tela pequena, sucesso e erro do servidor', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${base}/recuperar-senha.html`);
    assert.equal(await page.title(), 'Recuperar senha | Studiofy');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.type('#recuperacaoEmailInput', 'owner@example.test');
    await page.click('#recuperacaoLinkForm button');
    await page.waitForFunction(() => document.querySelector('#recuperacaoLinkMessage').textContent.includes('Studiofy'));
    assert.deepEqual(recoveryBody, { email: 'owner@example.test' });
    fail = true;
    await page.type('#recuperacaoEmailInput', 'owner@example.test');
    await page.click('#recuperacaoLinkForm button');
    await page.waitForFunction(() => document.querySelector('#recuperacaoLinkMessage').textContent.includes('indisponível'));
  });
  await t.test('redefinição envia token e senha, e exibe sucesso Studiofy', async () => {
    fail = false;
    await page.goto(`${base}/redefinir-senha.html?token=synthetic-browser-token`);
    assert.equal(await page.title(), 'Redefinir senha | Studiofy');
    await page.waitForSelector('#resetPasswordForm', { visible: true });
    await page.type('#novaSenhaInput', 'synthetic-password');
    await page.type('#confirmarSenhaInput', 'synthetic-password');
    await page.click('#resetPasswordForm [type=submit]');
    await page.waitForFunction(() => document.querySelector('#resetPasswordMessage').textContent.includes('Studiofy'));
    assert.deepEqual(resetBody, { token: 'synthetic-browser-token', novaSenha: 'synthetic-password', confirmarSenha: 'synthetic-password' });
  });
  await t.test('link expirado mantém formulário oculto e pede nova recuperação', async () => {
    fail = true;
    await page.goto(`${base}/redefinir-senha.html?token=synthetic-browser-token`);
    await page.waitForFunction(() => document.querySelector('#resetPasswordInfo').textContent.includes('expirou'));
    assert.equal(await page.$eval('#resetPasswordForm', el => el.hidden), true);
  });
  assert.deepEqual(errors, []);
});

test('páginas e scripts de recuperação usam Studiofy e preservam os endpoints', () => {
  const root = path.resolve(__dirname, '../public');
  for (const file of ['recuperar-senha.html', 'recuperar-senha.js', 'redefinir-senha.html', 'redefinir-senha.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, /Studiofy/);
    assert.doesNotMatch(source, /sal[aã]o\s*flix/i);
    assert.doesNotMatch(source, /recupera\?\?|voc\?|inv\?lido/);
  }
  assert.match(fs.readFileSync(path.join(root, 'recuperar-senha.js'), 'utf8'), /\/api\/barbeiro\/recuperar-senha\/solicitar/);
  assert.match(fs.readFileSync(path.join(root, 'redefinir-senha.js'), 'utf8'), /\/api\/barbeiro\/recuperar-senha\/redefinir/);
});
