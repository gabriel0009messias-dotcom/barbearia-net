const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(candidate => candidate && fs.existsSync(candidate));

test('cadastro no navegador: submit, checkout e erros visiveis', { skip: !executablePath }, async t => {
  const app = express();
  app.use(express.json());
  let failure = null;
  let gatewayEnabled = true;
  let plan = { name: 'Plano Profissional', amountCents: 6500, currency: 'BRL', durationDays: 30 };
  let signupCalls = 0;
  let checkoutCalls = 0;
  const paymentUrl = 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=browser-test';
  app.get('/api/publico/assinatura-config', (req, res) => {
    if (failure === 'config') return res.status(503).json({ error: 'Configuracao indisponivel.' });
    res.json({ diasVencimento: [5, 12, 24], gateway: { enabled: gatewayEnabled }, plan });
  });
  app.post('/api/publico/assinaturas', (req, res) => {
    signupCalls++;
    if (failure === 'existing') return res.status(409).json({ code: 'ASSINATURA_EXISTENTE', error: 'Os dados informados pertencem a uma assinatura existente.', assinatura: { id: 17 } });
    if (failure === 'signup') return res.status(400).json({ error: 'Preencha todos os campos obrigatorios.' });
    if (failure === 'missing') return res.status(404).json({ error: 'Rota nao encontrada.' });
    if (failure === 'server') return res.status(500).json({ error: 'Nao foi possivel salvar o cadastro. Tente novamente.' });
    if (failure === 'html') return res.status(502).type('html').send('<h1>Bad Gateway</h1>');
    if (failure === 'json') return res.type('json').send('invalid-json');
    res.status(201).json({ assinatura: { id: 17 } });
  });
  app.post('/api/publico/assinaturas/17/checkout', (req, res) => {
    checkoutCalls++;
    if (failure === 'checkout') return res.status(503).json({ error: 'Configure as credenciais e o webhook do Mercado Pago no servidor.' });
    if (failure === 'same-seller') return res.status(409).json({ error: 'Vendedor e comprador precisam ser diferentes. Este cadastro usa o e-mail da conta vendedora do Mercado Pago. Para testar uma compra, use um cadastro de cliente com outro e-mail e uma conta compradora diferente.' });
    res.json({ checkoutUrl: failure === 'url' ? null : paymentUrl, plan });
  });
  app.get('/api/publico/assinaturas/17/status', (req, res) => res.json({ liberado: false }));
  app.use(express.static(path.resolve(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  async function openForm({ storageBlocked = false, timeoutFast = false } = {}) {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.url().startsWith('https://www.mercadopago.com.br/')) {
        return request.respond({ status: 200, contentType: 'text/html', body: '<title>Checkout mock for test only</title>' });
      }
      if (failure === 'network' && request.url().endsWith('/api/publico/assinaturas')) return request.abort();
      if (failure === 'timeout' && request.url().endsWith('/api/publico/assinaturas')) return;
      return request.continue();
    });
    if (storageBlocked) await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
    });
    if (timeoutFast) await page.evaluateOnNewDocument(() => {
      const originalTimeout = window.setTimeout;
      window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 30000 ? 150 : delay, ...args);
    });
    await page.goto(`${base}/cadastro.html`);
    await page.waitForNetworkIdle({ idleTime: 100 });
    await page.waitForFunction(() => document.querySelector('#diaVencimentoInput').options.length > 0);
    await page.evaluate(() => {
      const values = { barbeariaNomeInput: 'Salao teste', responsavelNomeInput: 'Teste', telefoneAssinaturaInput: '11999998888', emailAssinaturaInput: 'buyer@example.test', cpfTitularInput: '12345678909', senhaAssinaturaInput: 'test-password', whatsappNumeroInput: '11999998888' };
      for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
    });
    return page;
  }
  await t.test('campos visiveis preenchidos permitem submit e redirecionam ao checkout', async () => {
    const page = await openForm();
    try {
      const invalid = await page.$$eval('input:invalid, select:invalid', fields => fields.map(field => field.id));
      assert.deepEqual(invalid, [], 'Campos de cartao ocultos nao podem bloquear o submit');
      await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
      assert.equal(page.url(), paymentUrl);
      assert.equal(signupCalls, 1);
      assert.equal(checkoutCalls, 1);
    } finally { await page.close(); }
  });
  for (const [scenario, expected] of [
    ['existing', 'HTTP 409'],
    ['signup', 'HTTP 400'], ['missing', 'HTTP 404'], ['server', 'HTTP 500'],
    ['html', 'HTTP 502'], ['json', 'resposta invalida'],
    ['checkout', 'Cadastro salvo, mas'], ['url', 'URL de pagamento valida'],
    ['same-seller', 'Vendedor e comprador precisam ser diferentes'],
    ['network', 'Verifique sua conexao'], ['timeout', 'demorou para responder'],
  ]) {
    await t.test(`falha ${scenario} aparece no formulario e permite tentar novamente`, async () => {
      failure = scenario;
      const page = await openForm({ timeoutFast: scenario === 'timeout' });
      const priorCheckouts = checkoutCalls;
      try {
        await page.click('button[type=submit]');
        await page.waitForFunction(message => document.querySelector('#assinaturaFormMessage').textContent.includes(message), {}, expected);
        assert.equal(await page.$eval('button[type=submit]', button => button.disabled), false);
        assert.equal(await page.$eval('#assinaturaFormMessage', element => {
          const box = element.getBoundingClientRect();
          return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
        }), true);
        if (!['checkout', 'url', 'same-seller'].includes(scenario)) assert.equal(checkoutCalls, priorCheckouts);
        if (scenario === 'same-seller') assert.equal(page.url(), `${base}/cadastro.html`);
        if (scenario === 'existing') {
          assert.equal(page.url(), `${base}/cadastro.html`);
          assert.equal(await page.$eval('#assinaturaExistenteActions', element => element.hidden), false);
          assert.equal(await page.$eval('#assinaturaExistenteActions a', element => element.getAttribute('href')), '/');
          assert.equal(await page.$eval('#gatewayCheckoutButton', element => element.hidden), true);
          assert.equal(await page.evaluate(() => localStorage.getItem('barbearia_pending_signup')), null);
        }
        assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('test-password')), false);
      } finally { await page.close(); failure = null; }
    });
  }
  await t.test('storage bloqueado nao impede cadastro e redirecionamento', async () => {
    const page = await openForm({ storageBlocked: true });
    try {
      await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
      assert.equal(page.url(), paymentUrl);
    } finally { await page.close(); }
  });
  await t.test('credenciais ausentes sao informadas antes do submit', async () => {
    gatewayEnabled = false;
    const page = await openForm();
    try {
      assert.match(await page.$eval('#cadastroConfigMessage', element => element.textContent), /configurar o Mercado Pago/);
    } finally { await page.close(); gatewayEnabled = true; }
  });
  await t.test('preco exibido vem da API, sem valor independente no HTML ou JS', async () => {
    const original = plan;
    plan = { ...plan, amountCents: 7200, durationDays: 45 };
    const page = await openForm();
    try {
      assert.match(await page.$eval('#planPriceLabel', element => element.textContent), /72,00 por 45 dias/);
      for (const file of ['cadastro.html', 'cadastro.js']) {
        assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, '../public', file), 'utf8'), /R\$\s*65|6500/);
      }
    } finally { await page.close(); plan = original; }
  });
  await t.test('erro na configuracao aparece sem deixar selects vazios', async () => {
    failure = 'config';
    const page = await openForm();
    try {
      assert.match(await page.$eval('#cadastroConfigMessage', element => element.textContent), /HTTP 503/);
      assert.deepEqual(await page.$$eval('input:invalid, select:invalid', fields => fields.map(field => field.id)), []);
    } finally { await page.close(); failure = null; }
  });
});
