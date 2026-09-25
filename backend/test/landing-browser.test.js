const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));

test('Landing 2A: tour isolado, preço real, navegação e responsividade',{skip:!executablePath,timeout:90000},async t=>{
 const app=express();let mode='ok',loginBody;
 app.use(express.json());
 app.get('/api/publico/assinatura-config',(_req,res)=>{
  if(mode==='error')return res.status(503).json({error:'Indisponível'});
  if(mode==='invalid')return res.json({plan:{amountCents:-1,durationDays:30,currency:'BRL'}});
  res.json({plan:{name:'Plano de verificação',amountCents:7990,durationDays:30,currency:'BRL'}});
 });
 app.post('/api/barbeiro/login',(req,res)=>{loginBody=req.body;res.json({token:'local-test-token'});});
 app.get('/api/barbeiro/me',(_req,res)=>res.status(401).json({error:'Sessao expirada'}));
 app.get('/api/studiofy/painel',(_req,res)=>res.status(401).json({error:'Sessão expirada'}));
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,page=await browser.newPage(),errors=[],requests=[];
 const artifacts=path.resolve(__dirname,'../../.tmp/etapa2a-preview');fs.mkdirSync(artifacts,{recursive:true});
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
 await page.setCacheEnabled(false);await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);

 await t.test('desktop: apresentação completa, mockup identificado e preço da API',async()=>{
  await page.setViewport({width:1440,height:1000});await page.goto(base,{waitUntil:'networkidle0'});
  await page.waitForSelector('.demo-message.is-visible');
  assert.match(await page.$eval('h1',el=>el.innerText.replace(/\s+/g,' ')),/Seu negócio organizado\. Seus clientes mais perto\./);
  assert.equal(await page.$$eval('#site-nav a',els=>els.length),8);
  assert.match(await page.$eval('#home-plan-price',el=>el.textContent),/79,90/);
  assert.equal(await page.$eval('#home-plan-name',el=>el.textContent),'Plano de verificação');
  assert.equal(await page.$$eval('.business-grid article',els=>els.length),6);
  assert.match(await page.$eval('.dashboard-mock',el=>el.textContent),/DADOS FICTÍCIOS/);
  assert.ok(await page.evaluate(()=>[...document.querySelectorAll('a[href^="#"]')].every(a=>document.getElementById(a.hash.slice(1)))));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(await page.$eval('.menu-toggle',el=>getComputedStyle(el).display),'none');
  await page.screenshot({path:path.join(artifacts,'landing-desktop.png'),fullPage:true});
  await page.screenshot({path:path.join(artifacts,'hero-desktop.png')});
  await page.$eval('.dashboard-mock',el=>el.scrollIntoView());await page.screenshot({path:path.join(artifacts,'dashboard-desktop.png')});
 });
 await t.test('cinco etapas, voltar e reiniciar nunca escrevem nem chamam WhatsApp',async()=>{
  const before=requests.length;
  await page.click('[data-choice="2"]');await page.click('[data-choice="2"]');await page.click('[data-choice="0"]');await page.click('[data-choice="1"]');
  assert.match(await page.$eval('.demo-summary',el=>el.textContent),/Massagem relaxante.*Alex.*Amanhã.*10h30/);
  await page.click('[data-action="back"]');assert.equal(await page.$eval('[aria-current="step"]',el=>el.textContent),'Horário');
  await page.click('[data-choice="2"]');await page.click('[data-action="confirm"]');
  assert.match(await page.$eval('#booking-demo-content',el=>el.textContent),/Nenhuma reserva ou mensagem foi criada/);
  assert.match(await page.$eval('#demo-chosen-time',el=>el.textContent),/Massagem relaxante.*Alex.*11:00/);
  assert.match(await page.$eval('#demo-owner-details',el=>el.textContent),/Ana.*Massagem relaxante.*Alex.*11:00/);
  assert.match(await page.$eval('#demo-owner-status',el=>el.textContent),/recebido na demonstração/);
  assert.match(await page.$eval('#demo-reminder',el=>el.textContent),/hoje às 11:00/);
  assert.match(await page.$eval('#demo-delivery-details',el=>el.textContent),/10:40/);
  await page.click('[data-action="restart"]');assert.equal(await page.$eval('[aria-current="step"]',el=>el.textContent),'Serviço');
  assert.match(await page.$eval('#demo-chosen-time',el=>el.textContent),/Manicure.*15:30/);
  await page.click('.demo-booking-link');
  assert.equal(requests.length,before);
  assert.ok(requests.filter(r=>r.url.includes('/api/')).every(r=>r.method==='GET'&&r.url.endsWith('/api/publico/assinatura-config')));
  assert.ok(requests.every(r=>new URL(r.url).origin===base));
  assert.equal(await page.evaluate(()=>localStorage.length),0);
 });
 await t.test('primeira dobra de notebook mostra proposta, CTA e smartphone completo',async()=>{
  await page.setViewport({width:1366,height:768});await page.goto(base,{waitUntil:'networkidle0'});
  assert.match(await page.$eval('.hero-description',el=>el.textContent),/Agendamento \+ WhatsApp \+ gestão do estabelecimento/);
  const fold=await page.evaluate(()=>({phone:document.querySelector('.demo-phone').getBoundingClientRect().bottom,cta:document.querySelector('.hero .actions').getBoundingClientRect().bottom,height:innerHeight}));
  assert.ok(fold.phone<=fold.height,JSON.stringify(fold));assert.ok(fold.cta<=fold.height,JSON.stringify(fold));
  assert.equal(await page.$$eval('.journey-map li',els=>els.length),7);
  assert.match(await page.$eval('.conversation-demo',el=>el.textContent),/consultar os horários disponíveis/);
  assert.match(await page.$eval('.top-services',el=>el.textContent),/Serviços mais realizados/);
 });
 await t.test('CTA apresenta trial real e acesso ao cadastro',async()=>{
  const before=requests.length;await page.click('.hero a[href="#teste-gratis"]');
  assert.equal(new URL(page.url()).hash,'#teste-gratis');
  assert.match(await page.$eval('#teste-gratis',el=>el.textContent),/Sem cartão para começar/);
  assert.equal(await page.$eval('#teste-gratis a.button',el=>el.getAttribute('href')),'/cadastro.html');
  assert.equal(requests.length,before);
 });
 await t.test('celular e tablet: sem overflow, smartphone e menu por teclado',async()=>{
  for(const width of [320,390,768]){
   await page.setViewport({width,height:844});await page.goto(base,{waitUntil:'networkidle0'});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`largura ${width}`);
   await page.click('.menu-toggle');assert.equal(await page.$eval('.menu-toggle',el=>el.getAttribute('aria-expanded')),'true');
   await page.keyboard.press('Escape');assert.equal(await page.$eval('.menu-toggle',el=>el.getAttribute('aria-expanded')),'false');
   assert.equal(await page.evaluate(()=>document.activeElement.className),'menu-toggle');
   await page.click('.menu-toggle');await page.click('#site-nav a[href="#recursos"]');assert.equal(await page.$eval('.menu-toggle',el=>el.getAttribute('aria-expanded')),'false');
   await page.$eval('.hero-showcase',el=>el.scrollIntoView());await page.waitForSelector('.demo-message.is-visible');
   assert.equal(await page.$$eval('.demo-message.is-visible',els=>els.length),5);
   const phone=await page.$eval('.demo-phone',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};});assert.ok(phone.left>=0&&phone.right<=width);
   if(width===390){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(artifacts,'landing-mobile.png'),fullPage:true});await page.screenshot({path:path.join(artifacts,'hero-mobile.png')});}
  }
 });
 await t.test('API indisponível ou preço inválido não vira oferta inventada',async()=>{
  for(const failure of ['error','invalid']){mode=failure;await page.goto(base,{waitUntil:'networkidle0'});assert.equal(await page.$eval('#home-plan-price',el=>el.textContent),'Consulte no cadastro');assert.match(await page.$eval('#home-plan-period',el=>el.textContent),/Não foi possível/);assert.equal(await page.$$eval('#booking-demo-content [data-choice]',els=>els.length),3);}mode='ok';
 });
 await t.test('Entrar preserva contrato de autenticação e sessão expirada retorna ao Login',async()=>{
  await page.setViewport({width:1440,height:1000});await page.goto(base,{waitUntil:'networkidle0'});
  await Promise.all([page.waitForNavigation(),page.click('#site-nav a[href="/login.html"]')]);
  await page.type('#loginIdentificadorInput','owner@example.test');await page.type('#loginSenhaInput','test-password');
  const expired=page.waitForResponse(r=>r.url().endsWith('/api/barbeiro/me')&&r.status()===401);
  await page.click('#loginBarbeiroForm [type=submit]');await expired;
  await page.waitForFunction(()=>location.pathname==='/login.html'&&document.querySelector('#loginBarbeiroForm')&&localStorage.getItem('barbearia_auth_token')==='local-test-token');
  assert.deepEqual(loginBody,{identificador:'owner@example.test',senha:'test-password'});
  for(const route of ['/cadastro.html','/recuperar-senha.html','/redefinir-senha.html']){
   const html=await (await fetch(base+route)).text();assert.match(html,/href="\/login.html"/);
  }
 });
 await t.test('sem JavaScript: navegação, apresentação e avisos continuam acessíveis',async()=>{
  const plain=await browser.newPage();await plain.setJavaScriptEnabled(false);await plain.setViewport({width:390,height:844});await plain.goto(base,{waitUntil:'networkidle0'});
  assert.ok(await plain.$eval('#site-nav',el=>el.getBoundingClientRect().height>0));assert.match(await plain.$eval('#teste-gratis',el=>el.textContent),/7 dias grátis/);
  assert.ok(await plain.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await plain.close();
 });
 assert.deepEqual(errors,[]);
});
