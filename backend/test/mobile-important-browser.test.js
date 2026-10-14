const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { financialSummary } = require('../services/finance');

test('Mobile: eventos curtos, textos de serviços e prévia contidos', { timeout: 180000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath, 'Chrome necessário para as regressões visuais');
  const publicRoot = path.resolve(__dirname, '../public');
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const service = { id: 1, nome: 'Corte e hidratação', categoria: 'Cabelo',
    descricao: 'Cuidado personalizado.', preco: 150, duracao: 60, ativo: true };
  const professional = { id: 1, nome: 'Ana Carolina', ativo: true, servicos: [1] };
  const pageData = { nome: 'Studio teste', slug: 'mobile-test', telefone: '11999990000',
    businessType: 'beauty_salon', descricao: 'Seu espaço de beleza.', cor: '#1386ff',
    city: 'São Paulo', state: 'SP', address: 'Avenida das Flores, 123', instagram: 'studio_teste',
    logo: 'data:image/png;base64,' + fs.readFileSync(path.join(publicRoot, 'assets/studiofy-icon-512.png')).toString('base64'),
    capa: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(publicRoot, 'assets/studiofy-interior.jpg')).toString('base64') };
  const appointments = [['08:00', 15], ['08:15', 15], ['08:30', 15], ['08:45', 15],
    ['09:00', 30], ['09:30', 45], ['10:15', 60]].map(([hora, duracao], i) => ({
    id: i + 1, data: date, hora, duracao, nome_cliente: 'Cliente ' + (i + 1),
    telefone: '1199999000' + i, servico_nome: 'Serviço ' + (i + 1), preco: 150,
    status: 'confirmado', studio_service_id: 1, profissional_id: 1, profissional: professional.nome,
  }));
  appointments.push({ ...appointments[0], id: 8, nome_cliente: 'Outro profissional',
    profissional_id: 2, profissional: 'Beatriz', duracao: 60 });
  let currentService, currentPage, serviceCalls;
  const reset = () => { currentService = { ...service }; currentPage = { ...pageData }; serviceCalls = []; };
  reset();
  const app = express(); app.use(express.json({ limit: '6mb' }));
  app.get('/api/barbeiro/me', (_req, res) => res.json({ id: 1, barbearia_nome: 'Studio teste',
    acesso: { liberado: true, status: 'subscription_active' } }));
  app.get('/api/studiofy/painel', (_req, res) => res.json({ pagina: currentPage,
    servicos: [currentService], profissionais: [professional, { ...professional, id: 2, nome: 'Beatriz' }],
    businessTypes: [{ code: 'beauty_salon', name: 'Salão de beleza' }], agendamentos: appointments,
    bloqueios: [], lembretes: [], agenda: { hoje: date }, financeiro: financialSummary(appointments) }));
  app.get('/api/chat/conversations/unread', (_req, res) => res.json({ messages: 0 }));
  app.get('/api/studiofy/horarios', (_req, res) => res.json(['08:00', '09:00', '10:00']));
  app.post('/api/studiofy/servicos', (req, res) => {
    serviceCalls.push({ method: 'POST', body: req.body }); currentService = { ...req.body, id: 1 }; res.json(currentService);
  });
  app.put('/api/studiofy/servicos/1', (req, res) => {
    serviceCalls.push({ method: 'PUT', body: req.body }); currentService = { ...req.body, id: 1 }; res.json(currentService);
  });
  app.delete('/api/studiofy/servicos/1', (_req, res) => {
    serviceCalls.push({ method: 'DELETE' }); currentService.ativo = false; res.json({ sucesso: true });
  });
  app.get('/api/studiofy/public/mobile-test', (_req, res) => res.json({ ...currentPage,
    servicos: [currentService], profissionais: [professional] }));
  app.get('/api/studiofy/public/mobile-test/horarios', (_req, res) => res.json(['08:00', '09:00']));
  app.get('/agendar/:slug', (_req, res) => res.sendFile(path.join(publicRoot, 'agendar.html')));
  app.use(express.static(publicRoot));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const errors = [];
  async function open(width, route = '/studiofy.html') {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width, height: width === 320 ? 640 : 1000, isMobile: width < 500, hasTouch: width < 500 });
    await page.setRequestInterception(true);
    page.on('request', r => r.url().startsWith(base) || r.url().startsWith('data:') ? r.continue() : r.abort());
    await page.evaluateOnNewDocument(() => localStorage.setItem('barbearia_auth_token', 'synthetic-mobile-test'));
    await page.goto(base + route);
    if (route === '/studiofy.html') await page.waitForSelector('[data-section]');
    return page;
  }
  async function section(page, name) {
    await page.evaluate(name => document.querySelector(`[data-section="${name}"]`).click(), name);
  }
  async function fits(page, width, selector) {
    const result = await page.evaluate(selector => {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, left: r.left, right: r.right };
    }, selector);
    assert.equal(result.viewport, width, 'O layout mobile não pode ampliar o viewport');
    assert.ok(result.document <= width + 1, `Documento ${result.document}px em ${width}px`);
    assert.ok(result.left >= -1 && result.right <= width + 1, selector + ' contido na tela');
  }
  async function reachable(page, selector) {
    await page.$eval(selector, e => e.scrollIntoView({ block: 'center', inline: 'center' }));
    assert.ok(await page.$eval(selector, e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && e.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }), selector + ' deve receber clique/toque');
  }
  async function capture(page, name, width) {
    if (!process.env.STUDIOFY_VISUAL_ARTIFACTS) return;
    fs.mkdirSync(process.env.STUDIOFY_VISUAL_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.STUDIOFY_VISUAL_ARTIFACTS, `${name}-${width}.png`), fullPage: true });
  }

  for (const width of [320, 360, 390, 430, 768, 1440]) {
    await t.test(`${width}px: 15/30/45/60 minutos sem colisão, posição temporal e detalhes`, async t => {
      reset(); const page = await open(width); t.after(() => page.close());
      await section(page, 'Agendamentos'); await fits(page, width, '#view');
      const boxes = await page.evaluate(() => [...document.querySelectorAll('[data-calendar-booking]')].map(e => {
        const r = e.getBoundingClientRect(); return { id: +e.dataset.calendarBooking, top: r.top, bottom: r.bottom,
          left: r.left, right: r.right, text: e.innerText, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight };
      }));
      assert.equal(boxes.length, appointments.length);
      const consecutive=boxes.filter(box=>box.id<=7).sort((a,b)=>a.id-b.id);
      for (let i = 1; i < consecutive.length; i++) assert.ok(consecutive[i - 1].bottom <= consecutive[i].top, 'Eventos consecutivos não podem se encobrir');
      const simultaneous=boxes.find(box=>box.id===8);
      assert.ok(consecutive[0].right <= simultaneous.left || simultaneous.right <= consecutive[0].left, 'Profissionais simultâneos permanecem separados');
      const clock = await page.evaluate(() => [...document.querySelectorAll('.calendar-hours span')].slice(0, 2).map(e => e.getBoundingClientRect().top));
      for (const row of appointments) {
        const box = boxes.find(b => b.id === row.id), minutes = +row.hora.slice(0, 2) * 60 + +row.hora.slice(3) - 480;
        assert.ok(Math.abs((box.top - clock[0]) / (clock[1] - clock[0]) * 60 - minutes) < 1, row.hora + ' alinhado à escala temporal');
        assert.ok(box.scrollHeight <= box.clientHeight + 1, 'Conteúdo do evento cabe na sua duração visual');
        assert.ok(box.text.includes(row.hora) && box.text.includes(row.nome_cliente) && box.text.includes(row.servico_nome));
        await reachable(page, `[data-calendar-booking="${row.id}"]`);
        await page.click(`[data-calendar-booking="${row.id}"]`);
        const text = await page.$eval('.agenda-dialog[open]', e => e.innerText);
        for (const value of [row.nome_cliente, row.servico_nome, row.profissional, row.hora, '150,00']) assert.ok(text.includes(value), value);
        await page.click('[data-close-details]');
      }
      await capture(page, 'calendar', width);
    });

    await t.test(`${width}px: serviços preservam todos os textos sem overflow`, async t => {
      reset(); const page = await open(width); t.after(() => page.close());
      for (const sample of [service, { ...service, nome: 'Nome de serviço muito longo '.repeat(3) },
        { ...service, nome: 'W'.repeat(100), categoria: 'CategoriaSemEspacos'.repeat(5), descricao: 'DescricaoSemEspacos'.repeat(50) },
        { ...service, nome: 'Cuidado <&> "especial" — çã 💇', categoria: 'Beleza & saúde', descricao: '<script>texto literal</script>' },
        { ...service, descricao: 'Descrição extensa com informações do estabelecimento. '.repeat(18), preco: 100000, duracao: 720 }]) {
        currentService = { ...sample }; await page.reload(); await page.waitForSelector('[data-section]');
        await section(page, 'Meus serviços'); await fits(page, width, '.service-row');
        const text = await page.$eval('.service-row', e => e.textContent);
        for (const value of [sample.nome, sample.categoria, sample.descricao, String(sample.duracao) + ' min']) assert.ok(text.includes(value));
        assert.equal(await page.$('.service-row script'), null);
        await reachable(page, '[data-edit-service]'); await reachable(page, '[data-delete-service]');
        assert.ok(await page.$eval('[data-edit-service]', e => { const style=getComputedStyle(e); return e.getBoundingClientRect().height <= parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+3; }), 'Fixed action label must stay on one line');
      }
      currentService = { ...service, nome: 'W'.repeat(100), categoria: 'CategoriaSemEspacos'.repeat(5), descricao: 'DescricaoSemEspacos'.repeat(50) };
      await page.reload(); await page.waitForSelector('[data-section]'); await section(page, 'Meus serviços');
      await capture(page, 'services', width);
    });

    await t.test(`${width}px: prévia contém nome, descrição, campos e imagens`, async t => {
      reset(); const page = await open(width); t.after(() => page.close()); await section(page, 'Minha página');
      for (const sample of [{ nome: 'Studio teste', descricao: 'Seu espaço de beleza.' },
        { nome: 'Nome longo de estabelecimento '.repeat(3), descricao: 'Uma descrição extensa. '.repeat(35) },
        { nome: 'W'.repeat(100), descricao: 'DescricaoSemEspacos'.repeat(50) },
        { nome: 'Studio <&> "especial" — çã ✨', descricao: 'Texto <literal> & sem transformação.' }]) {
        await page.evaluate(sample => {
          for (const [name, value] of Object.entries({ ...sample, instagram: 'studio_com_nome_longo', address: 'EnderecoSemEspacos'.repeat(12), city: 'CidadeSemEspacos'.repeat(5) })) {
            document.querySelector(`[name="${name}"]`).value = value;
          }
          document.querySelector('#previewButton').click();
        }, sample);
        await page.waitForFunction(name => document.querySelector('#preview h2')?.textContent === name, {}, sample.nome);
        await page.waitForFunction(() => [...document.querySelectorAll('#preview img')].every(e => e.complete && e.naturalWidth));
        await fits(page, width, '#preview'); await fits(page, width, '#editor');
        assert.equal(await page.$eval('#preview p', e => e.textContent), sample.descricao);
        assert.equal(await page.$eval('[name=nome]', e => e.value), sample.nome);
        assert.equal(await page.$eval('[name=descricao]', e => e.value), sample.descricao);
        const logo = await page.$eval('#preview .logo', e => ({ width: e.getBoundingClientRect().width,
          height: e.getBoundingClientRect().height, naturalWidth: e.naturalWidth, naturalHeight: e.naturalHeight }));
        assert.equal(logo.width, logo.height); assert.equal(logo.naturalWidth, logo.naturalHeight);
        await reachable(page, '#previewButton'); await reachable(page, '#editor [type=submit]');
      }
      await page.$eval('[name=nome]', e => { e.value = 'W'.repeat(100); e.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector('#preview h2').textContent === 'W'.repeat(100));
      await capture(page, 'preview', width);
    });
  }

  await t.test('Agenda normal e filtros mantêm as reservas e o formulário', async t => {
    reset(); const page = await open(320); t.after(() => page.close()); await section(page, 'Agendamentos');
    await page.select('#agendaProfessional', '2'); assert.equal(await page.$$eval('[data-calendar-booking]', es => es.length), 1);
    await page.select('#agendaProfessional', '1'); assert.equal(await page.$$eval('[data-calendar-booking]', es => es.length), 7);
    await page.click('[data-agenda-filter=hoje]'); assert.equal(await page.$$eval('[data-agenda-booking]', es => es.length), 7);
    await page.click('[data-agenda-filter=cancelados]'); assert.equal(await page.$$eval('[data-agenda-booking]', es => es.length), 0);
    await page.click('[data-agenda-filter=todos]');
    const original=structuredClone(appointments);
    try {
      appointments.splice(0,appointments.length,{...original[0],duracao:60},{...original[1],hora:'09:00',duracao:60});
      await page.evaluate(()=>refresh()); await page.click('#agendaMode');
      const hourHeight=await page.$eval('.calendar-hours span',e=>e.getBoundingClientRect().height);
      assert.equal(hourHeight,64,'Normal 60-minute appointments retain the original calendar density');
      await fits(page,320,'#view');
    } finally { appointments.splice(0,appointments.length,...original); }
    await page.click('#newBooking');
    await page.waitForSelector('#editor [name=nome_cliente]'); await fits(page, 320, '#editor');
  });
  await t.test('Adicionar, editar e desativar serviço preserva os contratos existentes', async t => {
    reset(); const page = await open(320); t.after(() => page.close()); await section(page, 'Meus serviços');
    await page.click('#addService'); await page.type('[name=nome]', 'Novo serviço'); await page.type('[name=preco]', '25');
    await fits(page, 320, '#editor'); await page.click('#editor [type=submit]');
    await page.waitForSelector('[data-edit-service]'); assert.equal(serviceCalls[0].method, 'POST');
    await page.click('[data-edit-service]'); await page.$eval('[name=nome]', e => { e.value = 'Serviço editado'; });
    await page.click('#editor [type=submit]'); await page.waitForFunction(() => document.querySelector('.service-row')?.textContent.includes('Serviço editado'));
    assert.equal(serviceCalls[1].method, 'PUT'); assert.equal(serviceCalls[1].body.preco, 25);
    await page.click('[data-delete-service]'); await page.waitForFunction(() => document.querySelector('.service-row .pill')?.textContent === 'Inativo');
    assert.equal(serviceCalls[2].method, 'DELETE'); assert.equal(currentService.ativo, false);
  });
  await t.test('Página pública e revisão de agendamento continuam responsivas nas seis larguras', async t => {
    reset(); currentPage.nome = 'W'.repeat(100); currentPage.descricao = 'DescricaoSemEspacos'.repeat(50);
    currentPage.address = 'EnderecoSemEspacos'.repeat(12); currentPage.city = 'CidadeSemEspacos'.repeat(5);
    currentService.nome = 'W'.repeat(100); currentService.descricao = 'DescricaoSemEspacos'.repeat(50);
    for (const width of [320, 360, 390, 430, 768, 1440]) {
      const page = await open(width, '/agendar/mobile-test'); t.after(() => page.close());
      await page.waitForSelector('[data-service]'); await fits(page, width, 'main'); await reachable(page, '[data-service]');
      await capture(page, 'public', width); await page.click('[data-service]');
      await page.$eval('#date', (e, date) => { e.value = date; e.dispatchEvent(new Event('change', { bubbles: true })); }, date);
      await page.waitForSelector('[data-time]'); await page.click('[data-time]');
      await page.type('#name', 'Cliente de teste'); await page.type('#phone', '11999990000');
      await reachable(page, '#review'); await page.click('#review'); await page.waitForSelector('#confirm');
      await fits(page, width, 'main'); await reachable(page, '#confirm');
      assert.ok((await page.$eval('#booking', e => e.textContent)).includes('Cliente de teste'));
      await capture(page, 'public-review', width);
    }
    assert.deepEqual(errors, []);
  });
});
