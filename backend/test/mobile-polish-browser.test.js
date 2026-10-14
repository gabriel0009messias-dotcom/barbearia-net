const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { financialSummary } = require('../services/finance');

test('Mobile etapa 2: navegação, leitura e acessibilidade', { timeout: 180000 }, async t => {
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
    servicos: emptyServices?[]:[currentService], profissionais: [professional, { ...professional, id: 2, nome: 'Beatriz' }],
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
  const errors = []; const authCalls=[]; let emptyServices=false;
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

  app.get('/api/barbeiro/recuperar-senha/token-status', (_req,res)=>res.json({email:'teste@example.test'}));
  app.post('/api/barbeiro/recuperar-senha/solicitar',(req,res)=>{authCalls.push({path:req.path,body:req.body});res.json({mensagem:'Link enviado.'});});
  app.post('/api/barbeiro/recuperar-senha/redefinir',(req,res)=>{authCalls.push({path:req.path,body:req.body});res.json({mensagem:'Senha atualizada.'});});
  app.get('/api/publico/assinatura-config',(_req,res)=>res.json({plan:{name:'Studiofy',amountCents:6500,currency:'BRL',durationDays:30},diasVencimento:[5,10,15],gateway:{enabled:true}}));
  app.get('/api/publico/business-types',(_req,res)=>res.json([{code:'beauty_salon',name:'Salão de beleza'}]));
  app.post('/api/admin/login',(_req,res)=>res.json({token:'synthetic-admin'}));
  app.get('/api/admin/assinatura-config',(_req,res)=>res.json({suporte:'Studiofy'}));
  app.get('/api/admin/assinaturas',(_req,res)=>res.json({assinaturas:[{id:1,barbearia_nome:'Studio teste',responsavel_nome:'Pessoa teste',email:'teste@example.test',telefone:'11999990000',status:'ativo',acesso:{liberado:true,status:'subscription_active'}}],pendentes:[]}));

  function luminance(rgb) {return rgb.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
  async function contrast(page,selector) {
    const colors=await page.$eval(selector,e=>{const s=getComputedStyle(e);return [s.color,s.backgroundColor].map(c=>c.match(/[\d.]+/g).map(Number));});
    const [a,b]=colors.map(luminance);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,selector+' contraste >=4.5:1');
  }
  async function target(page,selector){await page.$eval(selector,e=>e.scrollIntoView({block:'center'}));const r=await page.$eval(selector,e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height};});assert.ok(r.w>=44&&r.h>=44,selector+' toque 44px '+JSON.stringify(r));}
  for(const width of [320,360,390,430,768,1440]){
    await t.test(width+'px: cabeçalho, menu, serviços, formulários e tabelas',async t=>{
      reset(); const page=await open(width);t.after(()=>page.close());
      await page.$eval('#salonName',e=>e.textContent='EstabelecimentoSemEspacos'.repeat(40));
      await fits(page,width,'.topbar');await reachable(page,'#logout');await reachable(page,'#publicLink');
      if(width<=430){
        assert.equal(await page.$eval('#menuToggle',e=>e.getAttribute('aria-expanded')),'false');
        assert.equal(await page.$eval('#navigation',e=>e.hidden),true);
        await target(page,'#menuToggle');await page.focus('#menuToggle');await page.keyboard.press('Enter');
        assert.equal(await page.$eval('#menuToggle',e=>e.getAttribute('aria-expanded')),'true');
        assert.equal(await page.$$eval('[data-section]',es=>es.filter(e=>e.getBoundingClientRect().height>0).length),14);
        await page.focus('[data-section]');await page.keyboard.press('Escape');
        assert.equal(await page.$eval('#menuToggle',e=>document.activeElement===e),true);
        await page.click('#menuToggle');await target(page,'[data-section="Dashboard"]');
        await target(page,'.text-button');await target(page,'#logout');
      }else assert.equal(await page.$eval('#navigation',e=>e.hidden),false);
      await section(page,'Meus serviços');
      const positions=await page.$$eval('.service-category,.service-description',es=>es.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,text:e.textContent};}));
      assert.ok(positions[0].bottom<=positions[1].top,'categoria e descrição não colidem');
      await fits(page,width,'.service-list');await contrast(page,'#addService');
      if(width<=430){await target(page,'#addService');await target(page,'[data-edit-service]');await target(page,'[data-delete-service]');}
      await page.click('#addService');
      if(width<=430)assert.ok(await page.$$eval('#editor input,#editor select,#editor textarea',es=>es.every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)));
      for(const name of ['Dashboard','Agendamentos','Clientes','Profissionais','Financeiro','Horários','Minha página','Notificações','Relatórios','Configurações','Assinatura']){
        await section(page,name);await fits(page,width,'#view');
        if(name==='Minha página'){
          for(const color of ['#1386ff','#ffffff','#111111','#777777']){
            await page.$eval('[name=cor]',(e,color)=>e.value=color,color);await page.click('#previewButton');
            await page.waitForFunction(color=>document.querySelector('#preview button')?.style.backgroundColor===color,{},'rgb('+color.slice(1).match(/../g).map(x=>parseInt(x,16)).join(', ')+')');
            await contrast(page,'#preview button');
          }
        }
        await capture(page,name,width);
        if(['Clientes','Profissionais','Notificações'].includes(name)){
          const overflow=await page.$eval('.table-wrap',e=>e.scrollWidth>e.clientWidth+1);
          if(width<=430&&overflow){await page.waitForFunction(()=>!document.querySelector('.table-scroll-note').hidden);assert.ok(await page.$eval('.table-scroll-note',e=>getComputedStyle(e).display!=='none'));}
        }
      }
      // Resizing must restore the desktop menu after it was collapsed on mobile.
      await page.setViewport({width:1440,height:1000});await page.waitForFunction(()=>!document.querySelector('#navigation').hidden);
    });
    await t.test(width+'px: login, cadastro e senha com labels, contraste e contratos',async t=>{
      for(const route of ['/login.html','/cadastro.html','/recuperar-senha.html','/redefinir-senha.html?token=synthetic-token']){
        const page=await open(width,route);t.after(()=>page.close());
        if(route.includes('redefinir'))await page.waitForSelector('#resetPasswordForm:not([hidden])');
        await fits(page,width,'body');await contrast(page,'button[type=submit]');
        if(width<=430){await target(page,'button[type=submit]');assert.ok(await page.$$eval('input:not([type=checkbox]):not([type=hidden]),select,textarea',es=>es.filter(e=>e.getBoundingClientRect().height>0).every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)),'fontes >=16');}
        if(route.includes('recuperar')){
          assert.equal(await page.$eval('#recuperacaoEmailInput',e=>e.labels[0].textContent),'E-mail cadastrado');
          assert.equal(await page.$eval('#recuperacaoEmailInput',e=>e.autocomplete),'email');
          await page.type('#recuperacaoEmailInput','teste@example.test');await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('#recuperacaoLinkMessage').textContent==='Link enviado.');
          assert.deepEqual(authCalls.at(-1).body,{email:'teste@example.test'});
        }
        if(route.includes('redefinir')){
          assert.ok(await page.$$eval('#resetPasswordForm input',es=>es.every(e=>e.labels.length===1&&e.autocomplete==='new-password')));
          await capture(page,'redefinir-form',width);
          await page.type('#novaSenhaInput','NovaSenha123!');await page.type('#confirmarSenhaInput','NovaSenha123!');
          await page.click('[data-toggle-password="novaSenhaInput"]');assert.equal(await page.$eval('#novaSenhaInput',e=>e.type),'text');
          await page.click('button[type=submit]');await page.waitForFunction(()=>document.querySelector('#resetPasswordForm').hidden);
          assert.deepEqual(authCalls.at(-1).body,{token:'synthetic-token',novaSenha:'NovaSenha123!',confirmarSenha:'NovaSenha123!'});
        }
        await capture(page,route.split('?')[0].slice(1).replace('.html',''),width);
      }
    });
  }
  await t.test('serviços vazios orientam a criação; cadastro preserva contratos e acentos',async t=>{
    emptyServices=true;const page=await open(390);t.after(()=>page.close());await section(page,'Meus serviços');
    assert.match(await page.$eval('.service-list',e=>e.textContent),/Você ainda não cadastrou nenhum serviço.*Adicionar serviço/);
    await page.evaluate(()=>document.querySelector('#menuToggle').click());await page.click('#addService');assert.ok(await page.$('#editor'));
    const source=fs.readFileSync(path.join(publicRoot,'cadastro.js'),'utf8');assert.match(source,/Não consegui carregar a configuração/);assert.doesNotMatch(source,/Nao foi possivel/);
  });
  for(const width of [320,360,390,430,768,1440])await t.test(width+'px: Controle Interno e indicação de colunas escondidas',async t=>{
    const page=await open(width,'/controle-interno.html');t.after(()=>page.close());
    await contrast(page,'#adminLoginForm button');await page.type('#adminEmailInput','teste@example.test');await page.type('#adminSenhaInput','Synthetic123!');await page.click('#adminLoginForm button');
    await page.waitForFunction(()=>!document.querySelector('#adminPanel').hidden);await fits(page,width,'body');
    await contrast(page,'#sairAdminButton');await contrast(page,'#salvarSuporteButton');
    await page.waitForFunction(()=>document.querySelector('.table-wrap table').rows.length>1);
    const region=await page.$('.table-wrap');
    if(width<=430){
      await page.waitForFunction(()=>!document.querySelector('.table-scroll-note').hidden);
      await region.evaluate(e=>e.scrollLeft=e.scrollWidth);await page.waitForFunction(()=>document.querySelector('.table-scroll-note').hidden);
      await region.evaluate(e=>e.scrollLeft=0);await page.waitForFunction(()=>!document.querySelector('.table-scroll-note').hidden);
    }
    await capture(page,'controle-interno',width);
  });
  assert.deepEqual(errors,[]);
});
