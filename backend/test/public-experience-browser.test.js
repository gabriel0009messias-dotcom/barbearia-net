const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const puppeteer=require('puppeteer');

test('Etapa 3: experiência pública, cadastro e chat sem sobreposição',{timeout:120000},async t=>{
 const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
 assert.ok(executablePath,'Chrome necessário para validar a experiência pública');
 const app=express();app.use(express.json());
 let catalog,slots,status,holdCatalog,holdSlots,holdPost,posts,recovery,receipt,reply,configStatus=0,signupStatus=429,signupPosts=0;
 const long='Nome muito longo sem abreviar '+ 'EstabelecimentoServiçoProfissional'.repeat(6);
 const fixture=()=>({nome:long,descricao:long,address:long,city:'São Paulo',state:'SP',instagram:'studiofy_nome_longo',cor:'#ffffff',servicos:[{id:1,nome:long,descricao:long,preco:100000,duracao:720}],profissionais:[{id:1,nome:long,servicos:[1]}]});
 app.get('/api/studiofy/public/test',(_req,res)=>{if(holdCatalog){reply=res;return;}if(status==='catalog')return res.status(404).json({error:'SQL secret internal id'});res.json(catalog);});
 app.get('/api/studiofy/public/test/horarios',(_req,res)=>{if(holdSlots)return;if(status==='slots')return res.status(500).json({error:'SQL secret internal id'});if(status===429)return res.status(429).set('Retry-After','1').json({error:'SQL secret internal id'});res.json(slots);});
 const summary=body=>({estabelecimento:long,servico:long,profissional:long,preco:100000,duracao:720,data:body.data,hora:body.hora,slug:'test',status:'confirmado',futuro:true,cancelavel:true});
 app.post('/api/studiofy/public/test/agendamentos',(req,res)=>{posts++;if(status===409)return res.status(409).json({error:'SQL secret internal id'});if(status==='html429')return res.status(429).set('Retry-After','1').type('html').send('SQL secret');if(status===429)return res.status(429).set('Retry-After',new Date(Date.now()+2500).toUTCString()).json({error:'SQL secret internal id'});receipt={token:'a'.repeat(64),agendamento:summary(req.body)};if(!holdPost)res.status(201).json(receipt);});
 app.post('/api/studiofy/public/reservas/recuperar',(_req,res)=>{recovery++;res.json(receipt);});
 app.post('/api/studiofy/public/reservas/consultar',(_req,res)=>status==='private'?res.status(503).json({error:'SQL secret'}):res.json(summary({data:'2099-01-01',hora:'08:00'})));
 app.get('/api/publico/assinatura-config',(_req,res)=>configStatus==='html429'?res.status(429).set('Retry-After','1').type('html').send('SQL secret'):configStatus?res.status(configStatus).set('Retry-After','1').json({error:'SQL secret'}):res.json({plan:{name:long,amountCents:10000000,currency:'BRL',durationDays:30},diasVencimento:[5],gateway:{enabled:true}}));
 app.get('/api/publico/business-types',(_req,res)=>res.json([{code:'other',name:'Outro'}]));
 app.post('/api/publico/assinaturas',(_req,res)=>{signupPosts++;res.status(signupStatus).set('Retry-After','1').json({error:'SQL secret'});});
 app.get('/agendar/:slug',(_req,res)=>res.sendFile(path.resolve(__dirname,'../public/agendar.html')));
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,artifacts=path.resolve(__dirname,'../../.tmp/cadastro-publico-stage3/screenshots');fs.mkdirSync(artifacts,{recursive:true});
 let context,page;const errors=[];
 async function open(width=320,route='/agendar/test',configure=()=>{}){
  if(context)await context.close();context=await browser.createBrowserContext();page=await context.newPage();
  page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:844,isMobile:width<500,hasTouch:width<500});
  await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
  await page.evaluateOnNewDocument(()=>{const timeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>timeout(fn,window.fastTimeout&&[10000,15000,250,30000].includes(ms)?100:ms,...args);});
  catalog=fixture();slots=['08:00','08:30'];status=0;holdCatalog=holdSlots=holdPost=false;posts=recovery=0;receipt=null;configStatus=0;configure();await page.goto(base+route);
 }
 const noOverflow=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.querySelector('main').scrollWidth<=document.querySelector('main').clientWidth),true);
 async function exposed(selector){
  await page.$eval(selector,el=>el.scrollIntoView({block:'end'}));
  const result=await page.$eval(selector,el=>{const r=el.getBoundingClientRect(),chat=document.querySelector('#chatLauncher').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return {hit:el.contains(document.elementFromPoint(x,y)),separate:r.bottom<=chat.top||r.right<=chat.left||r.left>=chat.right,visible:r.top>=0&&r.bottom<=innerHeight};});
  assert.deepEqual(result,{hit:true,separate:true,visible:true},selector+' deve estar acessível acima do chat');await noOverflow();
 }
 const selectDate=async()=>page.$eval('#date',el=>{el.value=new Date(Date.now()+2*86400000).toISOString().slice(0,10);el.dispatchEvent(new Event('change',{bubbles:true}));});
 async function details(){await page.waitForSelector('[data-service]');await page.click('[data-service]');}
 async function review(){await details();await selectDate();await page.waitForSelector('[data-time]');await page.click('[data-time]');await page.type('#name','Cliente Teste');await page.type('#phone','11999990000');await page.click('#review');}

 for(const width of [1440,390,320]){
  await t.test(`${width}px: textos longos, imagens ausentes, Agendar e chat`,async()=>{
   await open(width);await page.waitForSelector('[data-service]');await exposed('[data-service]');
   assert.equal(await page.$('#salon img'),null);assert.ok(await page.$('.logo.image-fallback'));
   assert.doesNotMatch(await page.$eval('#cover',el=>getComputedStyle(el).backgroundImage),/url/);
   await page.screenshot({path:path.join(artifacts,`publico-${width}.png`)});
   await page.click('#chatLauncher');await page.waitForSelector('#chatDialog[open]');await noOverflow();await page.keyboard.press('Escape');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'chatLauncher');
  });
  await t.test(`${width}px: dados mobile, revisão, volta, confirmação e cancelamento`,async()=>{
   await open(width);await review();await exposed('#confirm');
   assert.match(await page.$eval('#booking',el=>el.textContent),/Cliente Teste/);assert.match(await page.$eval('#booking',el=>el.textContent),/100\.000,00/);
   await page.screenshot({path:path.join(artifacts,`revisao-${width}.png`)});
   await page.click('#edit');await page.waitForSelector('[data-time].selected');assert.equal(await page.$eval('#name',el=>el.value),'Cliente Teste');assert.equal(await page.$eval('#phone',el=>el.type),'tel');
   for(const id of ['name','phone','date','professional'])assert.equal(await page.$eval('#'+id,el=>el.labels.length>0),true);
   await exposed('#review');await page.click('#review');await page.click('#confirm');await page.waitForSelector('#copyPrivateBooking');
   assert.equal(posts,1);assert.match(await page.$eval('#booking',el=>el.textContent),/Agendamento confirmado!/);
   assert.doesNotMatch(await page.$eval('#booking',el=>el.textContent),/a{64}/);await exposed('#cancelBooking');await exposed('#copyPrivateBooking');
   await page.screenshot({path:path.join(artifacts,`confirmacao-${width}.png`)});
   await page.click('#cancelBooking');await page.waitForSelector('.cancel-dialog[open]');await noOverflow();assert.equal(await page.evaluate(()=>document.activeElement.id),'cancelBack');await page.click('#cancelBack');
  });
  await t.test(`${width}px: cadastro, campos e imagens opcionais sem overflow`,async()=>{
   await open(width,'/cadastro.html');await page.waitForFunction(()=>document.querySelector('#planPriceLabel').textContent.includes('100.000'));await noOverflow();
   for(const id of ['responsavelNomeInput','emailAssinaturaInput','telefoneAssinaturaInput','senhaAssinaturaInput'])assert.equal(await page.$eval('#'+id,el=>el.labels.length>0),true);
   assert.equal(await page.$eval('#telefoneAssinaturaInput',el=>el.type),'tel');assert.equal(await page.$eval('#emailAssinaturaInput',el=>el.autocomplete),'email');
   assert.equal(await page.$eval('#logoInput',el=>el.required),false);await page.screenshot({path:path.join(artifacts,`cadastro-${width}.png`),fullPage:true});
  });
 }
 await t.test('logo, capa e serviço quebrados recebem fallback neutro',async()=>{
  await open(320,'/agendar/test',()=>{catalog.logo='/missing-logo.png';catalog.capa='/missing-cover.png';catalog.servicos[0].foto='/missing-service.png';});
  await page.waitForSelector('.logo.image-fallback');await page.waitForSelector('.service-photo.image-fallback');await exposed('[data-service]');
  assert.equal(await page.$$eval('#salon img,#booking img',els=>els.length),0);assert.doesNotMatch(await page.$eval('#cover',el=>getComputedStyle(el).backgroundImage),/url/);
 });
 await t.test('catálogo em loading e resposta antiga não sobrescreve navegação',async()=>{
  await open(320,'/agendar/test',()=>holdCatalog=true);assert.match(await page.$eval('#booking',el=>el.textContent),/Carregando serviços e profissionais/);
  await page.click('#openMyBookings');reply.json(catalog);await page.waitForNetworkIdle({idleTime:50});assert.ok(await page.$('#savedBookings'));assert.equal(await page.$('[data-service]'),null);await noOverflow();
 });
 await t.test('catálogo indisponível não expõe detalhes internos e tem retry',async()=>{
  await open(320,'/agendar/test',()=>status='catalog');await page.waitForSelector('#retryPage');assert.doesNotMatch(await page.$eval('#message',el=>el.textContent),/SQL|secret|internal/);await exposed('#retryPage');
 });
 await t.test('serviços vazios sem dados inventados',async()=>{await open(320,'/agendar/test',()=>catalog.servicos=[]);await page.waitForFunction(()=>document.querySelector('#booking').textContent.includes('Nenhum serviço'));assert.equal(await page.$('[data-service]'),null);await noOverflow();});
 await t.test('profissionais incompatíveis impedem continuar',async()=>{await open(320,'/agendar/test',()=>catalog.profissionais=[]);await details();assert.match(await page.$eval('#slots',el=>el.textContent),/Nenhum profissional/);assert.equal(await page.$eval('#review',el=>el.disabled),true);await exposed('#back');});
 await t.test('horários vazios explicam como prosseguir',async()=>{await open();await details();slots=[];await selectDate();await page.waitForFunction(()=>document.querySelector('#slots').textContent.includes('Escolha outro dia'));assert.equal(await page.$eval('#review',el=>el.disabled),true);await noOverflow();});
 await t.test('loading de horários desabilita revisão e timeout oferece retry',async()=>{
  await open();await details();holdSlots=true;await page.evaluate(()=>window.fastTimeout=true);await selectDate();await page.waitForFunction(()=>document.querySelector('#slots').getAttribute('aria-busy')==='true');assert.equal(await page.$eval('#review',el=>el.disabled),true);
  await page.waitForSelector('#retrySlots');await page.waitForFunction(()=>document.querySelector('#slots').getAttribute('aria-busy')==='false');await exposed('#retrySlots');holdSlots=false;await page.click('#retrySlots');await page.waitForSelector('[data-time]');
 });
 await t.test('erro de horários não expõe SQL e retry preserva os dados',async()=>{await open();await details();await page.type('#name','Cliente');status='slots';await selectDate();await page.waitForSelector('#retrySlots');assert.doesNotMatch(await page.$eval('#message',el=>el.textContent),/SQL|secret/);status=0;await page.click('#retrySlots');await page.waitForSelector('[data-time]');assert.equal(await page.$eval('#name',el=>el.value),'Cliente');});
 await t.test('data inválida durante consulta encerra estado ocupado e não reativa revisão',async()=>{
  await open();await details();holdSlots=true;await selectDate();await page.waitForFunction(()=>document.querySelector('#slots').getAttribute('aria-busy')==='true');
  await page.$eval('#date',el=>{el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await page.$eval('#slots',el=>el.getAttribute('aria-busy')),'false');assert.equal(await page.$eval('#review',el=>el.disabled),true);assert.match(await page.$eval('#slots',el=>el.textContent),/data válida/);
 });
 await t.test('409 volta aos horários com dados válidos preservados',async()=>{await open();await review();status=409;await page.click('#confirm');await page.waitForSelector('#name');assert.equal(await page.$eval('#name',el=>el.value),'Cliente Teste');assert.match(await page.$eval('#message',el=>el.textContent),/escolha outro horário/);assert.equal(posts,1);});
 await t.test('429 de horários respeita Retry-After numérico',async()=>{await open();await details();status=429;await selectDate();await page.waitForSelector('#retrySlots');assert.equal(await page.$eval('#retrySlots',el=>el.disabled),true);status=0;await page.waitForFunction(()=>!document.querySelector('#retrySlots').disabled);await page.click('#retrySlots');await page.waitForSelector('[data-time]');});
 await t.test('429 de confirmação respeita Retry-After como data e mantém tentativa',async()=>{
  await open();await review();status=429;await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Muitas tentativas'));
  assert.equal(await page.$eval('#confirm',el=>el.disabled),true);assert.equal(await page.$eval('#recoverBooking',el=>el.disabled),true);
  await page.evaluate(()=>document.querySelector('#confirm').onclick());await new Promise(r=>setTimeout(r,80));assert.equal(posts,1);
  await page.waitForFunction(()=>!document.querySelector('#recoverBooking').disabled);await noOverflow();
 });
 await t.test('duplo clique, resultado incerto e recuperação não duplicam reserva',async()=>{
  await open();await review();holdPost=true;await page.evaluate(()=>{window.fastTimeout=true;const b=document.querySelector('#confirm');b.onclick();b.onclick();});
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('confirmar se a reserva foi criada'));assert.equal(posts,1);assert.ok(await page.$('#recoverBooking'));await exposed('#recoverBooking');
  await page.click('#recoverBooking');await page.waitForSelector('#copyPrivateBooking');assert.equal(posts,1);assert.equal(recovery,1);await noOverflow();
 });
 await t.test('cadastro com configuração em 429 encerra loading e tem retry protegido',async()=>{
  await open(320,'/cadastro.html',()=>configStatus=429);await page.waitForSelector('#retryConfig');assert.equal(await page.$eval('#retryConfig',el=>el.disabled),true);assert.doesNotMatch(await page.$eval('#cadastroConfigMessage',el=>el.textContent),/SQL|secret/);
  configStatus=0;await page.waitForFunction(()=>!document.querySelector('#retryConfig').disabled);await page.click('#retryConfig');await page.waitForFunction(()=>document.querySelector('#planPriceLabel').textContent.includes('100.000'));assert.equal(await page.$('#retryConfig'),null);await noOverflow();
 });
 await t.test('cadastro em 429 bloqueia novos envios até Retry-After',async()=>{
  await open(320,'/cadastro.html');await page.waitForFunction(()=>document.querySelector('#planPriceLabel').textContent.includes('100.000'));
  await page.evaluate(()=>{for(const [id,value] of Object.entries({responsavelNomeInput:'Cliente',emailAssinaturaInput:'cliente@example.test',senhaAssinaturaInput:'password123',telefoneAssinaturaInput:'11999990000',cpfTitularInput:'12345678909',barbeariaNomeInput:'Studio',whatsappNumeroInput:'11999990000',cityInput:'São Paulo',stateInput:'SP',serviceNameInput:'Serviço',servicePriceInput:'10'}))document.getElementById(id).value=value;});
  signupPosts=0;await page.click('[type=submit]');await page.waitForFunction(()=>document.querySelector('#assinaturaFormMessage').textContent.includes('Muitas tentativas'));assert.equal(await page.$eval('[type=submit]',el=>el.disabled),true);
  await page.$eval('#assinaturaForm',el=>el.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})));assert.equal(signupPosts,1);await page.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);await noOverflow();
 });
 await t.test('429 sem JSON mantém a espera no cadastro e na confirmação',async()=>{
  await open(320,'/cadastro.html',()=>configStatus='html429');await page.waitForSelector('#retryConfig');assert.equal(await page.$eval('#retryConfig',el=>el.disabled),true);assert.doesNotMatch(await page.$eval('#cadastroConfigMessage',el=>el.textContent),/SQL|secret/);
  await open();await review();status='html429';await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Muitas tentativas'));assert.equal(posts,1);assert.equal(await page.$eval('#recoverBooking',el=>el.disabled),true);
 });
 await t.test('acesso privado encerra loading após erro e permite consulta segura',async()=>{
  await open(320,'/agendar/test#reserva='+'b'.repeat(64),()=>status='private');await page.waitForSelector('#retryPage');assert.doesNotMatch(await page.$eval('#booking',el=>el.textContent),/Consultando/);assert.equal(new URL(page.url()).hash,'');
  status=0;await exposed('#retryPage');await page.click('#retryPage');await page.waitForSelector('#copyPrivateBooking');assert.equal(posts,0);assert.match(await page.$eval('#booking',el=>el.textContent),/Seu agendamento/);
 });
 await t.test('navegação por teclado mostra foco e mantém ações acessíveis',async()=>{
  await open();await details();await page.$eval('#name',el=>el.focus());await page.keyboard.type('Cliente Teclado');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'phone');
  assert.notEqual(await page.$eval('#phone',el=>getComputedStyle(el).outlineStyle),'none');await exposed('#phone');await page.keyboard.type('11999990000');await selectDate();await page.waitForSelector('[data-time]');
  await page.$eval('[data-time]',el=>el.focus());await page.keyboard.press('Enter');assert.equal(await page.$eval('[data-time]',el=>el.getAttribute('aria-pressed')),'true');await exposed('#review');await page.$eval('#review',el=>el.focus());await page.keyboard.press('Enter');await page.waitForSelector('#confirm');await noOverflow();
 });
 assert.deepEqual(errors,[]);
});
