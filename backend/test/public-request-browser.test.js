const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const express=require('express');
const puppeteer=require('puppeteer');

test('Etapa 2 no navegador: timeout, confirmação recuperável e respostas antigas',{timeout:90000},async t=>{
 const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
 const app=express();app.use(express.json());app.use(express.static(path.resolve(__dirname,'../public')));
 app.get('/agendar/:slug',(_req,res)=>res.sendFile(path.resolve(__dirname,'../public/agendar.html')));
 let profiles=0,profileFail=0,holdProfile=false,profileReplies=[],slots=0,slotFail=0,holdSlots=false,slotReplies=[],posts=0,holdPost=false,postReplies=[],receipts=new Map(),bodies=[],keys=[],postStatus=0,recoveryKeys=[],recoveryBodies=[],holdCancel=false;
 const profile=()=>({nome:'Studio Rede',cor:'#ffffff',servicos:[{id:1,nome:'Manicure',preco:35.2,duracao:30},{id:2,nome:'Design',preco:40,duracao:30}],profissionais:[{id:1,nome:'Ana',servicos:[1,2]},{id:2,nome:'Bia',servicos:[1,2]}]});
 app.get('/api/studiofy/public/test',(_req,res)=>{profiles++;if(holdProfile){profileReplies.push(res);return;}if(profileFail-->0)return res.status(503).json({error:'Falha temporária'});res.json(profile());});
 app.get('/api/studiofy/public/test/horarios',(req,res)=>{slots++;if(holdSlots){slotReplies.push({res,query:req.query});return;}if(slotFail-->0)return res.status(503).json({error:'Falha temporária'});res.json(['08:00','08:30']);});
 const summary=body=>({nome_cliente:body.nome_cliente,estabelecimento:'Studio Rede',servico:'Manicure',profissional:'Ana',slug:'test',preco:35.2,duracao:30,status:'confirmado',cancelavel:true,futuro:true,data:body.data,hora:body.hora,inicio:body.data+'T08:00:00-03:00',antecedencia_minutos:0});
 app.post('/api/studiofy/public/test/agendamentos',(req,res)=>{
  posts++;const key=req.headers['idempotency-key'];keys.push(key);bodies.push(req.body);
  if(postStatus===429)return res.status(429).set('Retry-After','1').json({error:'Muitas tentativas. Aguarde antes de tentar novamente.'});
  if(!receipts.has(key))receipts.set(key,{token:crypto.createHash('sha256').update(key).digest('hex'),agendamento:summary(req.body)});
  const result=receipts.get(key);if(holdPost){postReplies.push({res,result});return;}res.status(201).json(result);
 });
 app.post('/api/studiofy/public/reservas/consultar',(req,res)=>{const item=[...receipts.values()].find(x=>x.token===req.body.token);item?res.json(item.agendamento):res.status(404).json({error:'Link inválido.'});});
 app.post('/api/studiofy/public/reservas/recuperar',(req,res)=>{recoveryKeys.push(req.body.chave);recoveryBodies.push(req.body.solicitacao);const result=receipts.get(req.body.chave);result?res.json(result):res.status(404).json({error:'Confirmação não encontrada.',code:'CONFIRMATION_NOT_FOUND'});});
 app.post('/api/studiofy/public/reservas/cancelar',(req,res)=>{const item=[...receipts.values()].find(x=>x.token===req.body.token);if(item){item.agendamento.status='cancelado';item.agendamento.cancelavel=false;}if(!holdCancel)res.json(item?.agendamento||{});});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,date=new Date(Date.now()+2*86400000).toISOString().slice(0,10),later=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
 let page,context;const errors=[];
 const open=async()=>{
  if(context)await context.close();context=await browser.createBrowserContext();page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  profiles=slots=posts=profileFail=slotFail=postStatus=0;holdProfile=holdSlots=holdPost=holdCancel=false;profileReplies=[];slotReplies=[];postReplies=[];receipts=new Map();bodies=[];keys=[];recoveryKeys=[];recoveryBodies=[];
  await page.evaluateOnNewDocument(()=>{
   const timeout=window.setTimeout.bind(window),fetch=window.fetch.bind(window);
   window.setTimeout=(fn,ms,...args)=>timeout(fn,window.fastTimeout&&[10000,15000,250].includes(ms)?(ms===250?5:120):ms,...args);
   window.fetch=(url,options)=>fetch(url,window.ignoreAbort?{...options,signal:undefined}:options);
  });
 };
 const goto=async()=>{await page.goto(base+'/agendar/test');await page.waitForSelector('[data-service]');};
 const change=async(value=date)=>page.$eval('#date',(el,value)=>{el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));},value);
 const until=async fn=>{const deadline=Date.now()+5000;while(!fn()){assert.ok(Date.now()<deadline,'Requisição deve alcançar servidor');await new Promise(r=>setTimeout(r,10));}};
 const review=async()=>{await page.click('[data-service="1"]');await change();await page.waitForSelector('[data-time]');await page.click('[data-time]');await page.type('#name','Cliente Rede');await page.type('#phone','11999990000');await page.click('#review');};

 await t.test('catálogo de serviços/profissionais tem retry de consulta seguro',async()=>{
  await open();profileFail=1;await goto();assert.equal(profiles,2);assert.equal(posts,0);assert.ok(await page.$('[data-service="2"]'));
 });
 await t.test('timeout de consulta encerra loading e permite tentar novamente',async()=>{
  await open();await goto();await page.click('[data-service]');await page.evaluate(()=>window.fastTimeout=true);holdSlots=true;await change();await page.waitForSelector('#retrySlots');
  assert.equal(slots,2);assert.equal(await page.$eval('#review',el=>el.disabled),true);assert.match(await page.$eval('#message',el=>el.textContent),/demorou demais/);
  holdSlots=false;await page.click('#retrySlots');await page.waitForSelector('[data-time]');assert.equal(posts,0);
 });
 await t.test('consulta de disponibilidade com 503 é repetida sem perder dados',async()=>{
  await open();await goto();await page.click('[data-service]');slotFail=1;await page.type('#name','Cliente Rede');await change();await page.waitForSelector('[data-time]');assert.equal(slots,2);assert.equal(await page.$eval('#name',el=>el.value),'Cliente Rede');
 });
 await t.test('data B vence data A mesmo se transporte ignorar AbortController',async()=>{
  await open();await goto();await page.click('[data-service]');await page.evaluate(()=>window.ignoreAbort=true);holdSlots=true;await change();await until(()=>slotReplies.length===1);
  holdSlots=false;await change(later);await page.waitForSelector('[data-time="08:00"]');slotReplies[0].res.json(['17:00']);await page.waitForNetworkIdle({idleTime:50});
  assert.equal(await page.$('[data-time="17:00"]'),null);assert.equal(await page.$eval('#date',el=>el.value),later);assert.equal(await page.$eval('#review',el=>el.disabled),true);
 });
 await t.test('resposta de profissional antigo não reativa disponibilidade',async()=>{
  await open();await goto();await page.click('[data-service]');await page.evaluate(()=>window.ignoreAbort=true);holdSlots=true;await change();await until(()=>slotReplies.length===1);
  holdSlots=false;await page.select('#professional','2');await page.waitForSelector('[data-time="08:00"]');slotReplies[0].res.json(['17:00']);await page.waitForNetworkIdle({idleTime:50});
  assert.equal(await page.$('[data-time="17:00"]'),null);assert.equal(await page.$eval('#professional',el=>el.value),'2');
 });
 await t.test('resposta do serviço anterior não altera novo serviço',async()=>{
  await open();await goto();await page.click('[data-service="1"]');await page.evaluate(()=>window.ignoreAbort=true);holdSlots=true;await change();await until(()=>slotReplies.length===1);
  await page.click('#back');holdSlots=false;await page.click('[data-service="2"]');await page.waitForSelector('[data-time="08:00"]');slotReplies[0].res.json(['17:00']);await page.waitForNetworkIdle({idleTime:50});
  assert.equal(await page.$eval('#booking h2',el=>el.textContent),'Design');assert.equal(await page.$('[data-time="17:00"]'),null);
 });
 await t.test('catálogo atrasado não sobrescreve navegação para Meus agendamentos',async()=>{
  await open();holdProfile=true;await page.goto(base+'/agendar/test');await page.evaluate(()=>window.ignoreAbort=true);await until(()=>profileReplies.length===1);await page.click('#openMyBookings');
  profileReplies[0].json(profile());await page.waitForNetworkIdle({idleTime:50});assert.ok(await page.$('#savedBookings'));assert.equal(await page.$('[data-service]'),null);
 });
 await t.test('duplo clique e chamadas repetidas enviam uma única confirmação',async()=>{
  await open();await goto();await review();holdPost=true;
  await page.evaluate(()=>{const b=document.querySelector('#confirm');b.onclick();b.onclick();b.dispatchEvent(new MouseEvent('click'));});await until(()=>postReplies.length===1);
  assert.equal(posts,1);assert.match(keys[0],/^[a-f0-9]{64}$/);assert.equal(await page.$eval('#confirm',el=>el.disabled),true);
  postReplies[0].res.status(201).json(postReplies[0].result);await page.waitForSelector('#privateBookingLink');assert.equal(receipts.size,1);
 });
 await t.test('confirmação atrasada é guardada sem sobrescrever navegação posterior',async()=>{
  await open();await goto();await review();holdPost=true;await page.click('#confirm');await until(()=>postReplies.length===1);await page.click('#openMyBookings');
  postReplies[0].res.status(201).json(postReplies[0].result);await page.waitForNetworkIdle({idleTime:50});assert.ok(await page.$('#savedBookings'));assert.equal(await page.$('#privateBookingLink'),null);
  await page.click('#openMyBookings');await page.waitForSelector('[data-reservation]');assert.equal(receipts.size,1);
 });
 await t.test('resposta perdida encerra loading, mantém chave após reload e recupera sem retry cego',async()=>{
  await open();await goto();await review();await page.evaluate(()=>window.fastTimeout=true);holdPost=true;await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('confirmar se a reserva foi criada'));
  assert.equal(posts,1);assert.equal(receipts.size,1);assert.equal(await page.$eval('#confirm',el=>el.disabled),false);assert.equal(await page.$eval('#recoverBooking',el=>el.disabled),false);
  const originalKey=keys[0],originalBody=bodies[0];await page.reload();await page.waitForSelector('[data-service]');holdPost=false;await page.click('#recoverBooking');await page.waitForSelector('#privateBookingLink');
  assert.equal(posts,1);assert.equal(receipts.size,1);assert.equal(recoveryKeys[0],originalKey);assert.deepEqual(recoveryBodies[0],originalBody);
  const stored=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('studiofy_public_pending:')));assert.deepEqual(stored,[]);
 });
 await t.test('sem armazenamento não envia criação irreversível sem recuperação',async()=>{
  await open();await goto();await review();await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('blocked');};});await page.click('#confirm');
  await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('guardar a tentativa'));assert.equal(posts,0);
 });
 await t.test('429 não dispara retry automático de criação e preserva tentativa segura',async()=>{
  await open();await goto();await review();postStatus=429;await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Muitas tentativas'));
  assert.equal(posts,1);assert.equal(receipts.size,0);assert.equal(await page.$eval('#confirm',el=>el.disabled),true);assert.equal(await page.$eval('#recoverBooking',el=>el.disabled),true);
  const original=keys[0];postStatus=0;await page.waitForFunction(()=>!document.querySelector('#recoverBooking').disabled);await page.click('#recoverBooking');await page.waitForSelector('#privateBookingLink');assert.equal(posts,2);assert.equal(keys[1],original);
 });
 await t.test('recuperar uma tentativa não apaga outra tentativa de outra aba',async()=>{
  await open();await goto();await review();await page.evaluate(()=>window.fastTimeout=true);holdPost=true;await page.click('#confirm');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('confirmar se a reserva foi criada'));
  const other='e'.repeat(64);await page.evaluate(key=>{const prefix=Object.keys(localStorage).find(k=>k.startsWith('studiofy_public_pending:')).slice(0,-64);const original=JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith(prefix))));localStorage.setItem(prefix+key,JSON.stringify({...original,key,createdAt:Date.now()+1000}));},other);
  holdPost=false;await page.click('#recoverBooking');await page.waitForSelector('#privateBookingLink');
  const remaining=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('studiofy_public_pending:')));assert.equal(remaining.length,1);assert.ok(remaining[0].endsWith(other));assert.equal(receipts.size,1);
 });
 await t.test('timeout do cancelamento encerra loading e orienta consultar o estado real',async()=>{
  await open();await goto();await review();await page.click('#confirm');await page.waitForSelector('#privateBookingLink');await page.evaluate(()=>window.fastTimeout=true);
  holdCancel=true;await page.click('#cancelBooking');await page.click('#confirmCancellation');await page.waitForFunction(()=>document.querySelector('#cancelError').textContent.includes('Consulte seu agendamento'));
  assert.equal(await page.$eval('#confirmCancellation',el=>el.disabled),false);assert.equal(receipts.size,1);
  await page.click('#cancelBack');await page.click('#myBookings');await page.waitForFunction(()=>document.querySelector('#savedBookings').textContent.includes('Nenhum agendamento futuro'));
 });
 assert.deepEqual(errors,[]);
});
