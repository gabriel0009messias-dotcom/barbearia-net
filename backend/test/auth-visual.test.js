const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));

test('Login e cadastro: visual responsivo, simulação local e contratos preservados',{skip:!executablePath},async t=>{
 const app=express();app.use(express.json());let loginBody;
 app.get('/api/publico/assinatura-config',(_req,res)=>res.json({diasVencimento:[5,12,24],gateway:{enabled:true},plan:{name:'Plano Profissional',amountCents:6500,durationDays:30,currency:'BRL'}}));
 app.get('/api/publico/business-types',(_req,res)=>res.json([{code:'other',name:'Outro'},{code:'nails',name:'Unhas/Manicure'}]));
 app.post('/api/barbeiro/login',(req,res)=>{loginBody=req.body;res.status(401).json({error:'Login inválido de teste.'});});
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,page=await browser.newPage(),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',req=>{if(req.url().includes('/api/'))requests.push(req.url());});
 const artifacts=path.resolve(__dirname,'../../.tmp/auth-preview');fs.mkdirSync(artifacts,{recursive:true});
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await t.test('desktop: formulário à esquerda e demonstração à direita',async()=>{
  await page.setViewport({width:1440,height:1000});await page.goto(base);await page.waitForSelector('.demo-message.is-visible');
  const positions=await page.evaluate(()=>({form:document.querySelector('.auth-form-side').getBoundingClientRect().right,demo:document.querySelector('.auth-showcase').getBoundingClientRect().left}));
  assert.ok(positions.form<=positions.demo);
  assert.equal(await page.$$eval('.demo-message.is-visible',els=>els.length),5);
  await page.screenshot({path:path.join(artifacts,'login-desktop.png'),fullPage:true});
  await page.type('#loginIdentificadorInput','teste@example.test');await page.type('#loginSenhaInput','senha-teste');await page.click('#loginBarbeiroForm [type=submit]');
  await page.waitForFunction(()=>document.querySelector('#loginBarbeiroMessage').textContent.includes('Login inválido'));
  assert.deepEqual(loginBody,{identificador:'teste@example.test',senha:'senha-teste'});
 });
 await t.test('cadastro preserva os campos multissegmento e mostra seções legíveis',async()=>{
  await page.goto(base+'/cadastro.html');await page.waitForSelector('.demo-message.is-visible');
  await page.waitForFunction(()=>document.querySelector('#planPriceLabel').textContent.includes('65'));
  for(const id of ['barbeariaNomeInput','responsavelNomeInput','businessTypeInput','cityInput','stateInput','addressInput','instagramInput','logoInput','coverInput','serviceNameInput','servicePriceInput','serviceDurationInput','serviceCategoryInput','telefoneAssinaturaInput','emailAssinaturaInput','cpfTitularInput','senhaAssinaturaInput','metodoPagamentoInput','diaVencimentoInput','whatsappNumeroInput'])assert.ok(await page.$('#'+id),id);
  assert.equal(await page.$$eval('.auth-fieldset',els=>els.length),5);
  await page.screenshot({path:path.join(artifacts,'cadastro-desktop.png'),fullPage:true});
  await page.screenshot({path:path.join(artifacts,'cadastro-desktop-inicio.png')});
 });
 await t.test('mobile: formulário primeiro e sem rolagem horizontal',async()=>{
  for(const [route,name] of [['/','login'],['/cadastro.html','cadastro']]){
   await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});await page.goto(base+route);await page.waitForSelector('.demo-phone');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.ok(await page.evaluate(()=>document.querySelector('.auth-showcase').getBoundingClientRect().top>=document.querySelector('.auth-form-side').getBoundingClientRect().bottom));
   await page.$eval('.auth-showcase',el=>el.scrollIntoView());await page.waitForSelector('.demo-message.is-visible');await page.evaluate(()=>scrollTo(0,0));
   await page.screenshot({path:path.join(artifacts,name+'-mobile.png'),fullPage:true});
  }
 });
 await t.test('animação mostra digitação e troca segmento sem chamar a API',async()=>{
  await page.setViewport({width:1440,height:1000,isMobile:false});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);await page.goto(base);await page.waitForNetworkIdle({idleTime:100});
  const before=requests.length;
  await page.waitForFunction(()=>document.querySelector('.demo-chat-state').textContent.includes('digitando'));
  await page.click('[data-demo-control]');assert.equal(await page.$eval('[data-demo-control]',el=>el.textContent),'Rever');
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.click('[data-segment="3"]');assert.equal(await page.$eval('.demo-chat-name',el=>el.textContent),'Espaço Sereno');
  await page.click('.demo-booking-link');assert.equal(requests.length,before);assert.equal(await page.$$eval('.demo-message.is-visible',els=>els.length),5);
 });
 assert.deepEqual(errors,[]);
});
