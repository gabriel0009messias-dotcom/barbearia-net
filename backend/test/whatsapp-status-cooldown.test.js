const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const puppeteer=require('puppeteer');

test('status: 429, bloqueio local sem renovar prazo, expiracao e recuperacao', {timeout:60000}, async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 Object.assign(process.env,{NODE_ENV:'test',RENDER:'false',PUBLIC_APP_URL:'',EVOLUTION_API_URL:'https://status-only.test',EVOLUTION_API_KEY:'synthetic-status-key',EVOLUTION_STATUS_TRACE:'true',MERCADO_PAGO_ACCESS_TOKEN:''});
 const db=require('../database');await db.ready;
 const app=express();app.use(express.json());app.use('/api',require('../routes'));app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}`;process.env.PUBLIC_APP_URL=base;
 const originalFetch=global.fetch,realNow=Date.now;let offset=0,upstream=0,fault=true,responseGate=null;
 t.mock.method(Date,'now',()=>realNow()+offset);
 const logs=[];for(const level of ['info','error'])t.mock.method(console,level,(_prefix,data)=>{try{logs.push(JSON.parse(data));}catch{}});
 t.mock.method(global,'fetch',async(url,options)=>{
  if(String(url).startsWith(base))return originalFetch(url,options);
  const u=new URL(url);assert.equal(u.origin,'https://status-only.test');assert.match(u.pathname,/^\/instance\/connectionState\//);
  assert.equal(options.method,'GET');upstream++;if(responseGate)await responseGate;
  return fault?Response.json({message:'Too Many Requests'},{status:429,headers:{'Retry-After':'60'}}):Response.json({instance:{state:'open'}});
 });
 let browser; t.after(async()=>{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
 const api=async(route,token,method='GET',body)=>{const r=await originalFetch(base+'/api'+route,{method,headers:{'Content-Type':'application/json','x-barbeiro-token':token||''},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,headers:r.headers,body:await r.json()};};
 const signup=await api('/publico/assinaturas',null,'POST',{barbeariaNome:'Status local',responsavelNome:'Teste',telefone:'11999994001',email:'status-cooldown@example.test',senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Corte',preco:40}]});assert.equal(signup.status,201);
 const login=await api('/barbeiro/login',null,'POST',{identificador:'status-cooldown@example.test',senha:'test-password'});assert.equal(login.status,200);
 const id=signup.body.assinatura.id,token=login.body.token;
 await db.runAsync('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2',['status-fixture',id]);
 const route=`/publico/assinaturas/${id}/whatsapp/status`;
 const executablePath=[puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>fs.existsSync(p));
 browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 const page=await browser.newPage();page.setDefaultTimeout(10000);
 let browserRequests=0,firstDiagnostic;page.on('request',r=>{if(r.url().includes('/whatsapp/'))browserRequests++;});
 await page.evaluateOnNewDocument(token=>{
  localStorage.setItem('barbearia_auth_token',token);
  const original=Date.now;window.statusClockOffset=-300000;Date.now=()=>original()+window.statusClockOffset;
 },token);
 await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="WhatsApp"]');
 await t.test('Dashboard nao consulta status; entrada faz uma chamada e recebe 429',async()=>{
  assert.equal(upstream,0);const wait=page.waitForResponse(r=>r.url().endsWith('/whatsapp/status'));
  await page.click('[data-section="WhatsApp"]');const response=await wait;assert.equal(response.status(),429);
  firstDiagnostic=(await response.json()).diagnostic;
  assert.equal(firstDiagnostic.endpoint,'/instance/connectionState/status-fixture');
  assert.equal(firstDiagnostic.httpStatus,429);
  assert.equal(firstDiagnostic.trigger,'section_open');
  assert.equal(firstDiagnostic.requestId,response.headers()['x-request-id']);
  await page.waitForFunction(()=>document.querySelector('#whatsappNotice').textContent.includes('temporariamente'));
  assert.equal(upstream,1);assert.equal(browserRequests,1);
 });
 await t.test('contador usa prazo do backend mesmo com relogio do navegador atrasado',async()=>{
  const notice=await page.$eval('#whatsappNotice',e=>e.textContent);
  const seconds=Number(notice.match(/(\d+) s\./)?.[1]);assert.ok(seconds>0&&seconds<=60,notice);
 });
 let originalDeadline;
 await t.test('cliques no botao bloqueado nao fazem fetch; HTTP direto retorna cooldown local',async()=>{
  await page.evaluate(()=>{for(let i=0;i<5;i++)document.querySelector('#whatsappRefresh').dispatchEvent(new MouseEvent('click'));});
  assert.equal(browserRequests,1);
  const r=await api(route,token);assert.equal(r.status,429);assert.equal(r.body.rateLimitSource,'local_cooldown');assert.equal(upstream,1);
  assert.deepEqual(r.body.diagnostic,firstDiagnostic);
  originalDeadline=r.body.retryAt;
  offset+=50000;
  for(let i=0;i<3;i++){const next=await api(route,token);assert.equal(next.body.retryAt,originalDeadline);assert.ok(next.body.retryAfterSeconds<=10);}
  assert.equal(upstream,1);
 });
 await t.test('remontar faltando dez segundos nao reinicia bloqueio de trinta segundos',async()=>{
  await page.reload();await page.waitForSelector('[data-section="WhatsApp"]');await page.click('[data-section="WhatsApp"]');
  await page.waitForFunction(()=>document.querySelector('#whatsappNotice').textContent.includes('temporariamente'));
  const notice=await page.$eval('#whatsappNotice',e=>e.textContent);const seconds=Number(notice.match(/(\d+) s\./)?.[1]);assert.ok(seconds>0&&seconds<=10,notice);assert.equal(upstream,1);
 });
 await t.test('apos expirar, clique duplo faz uma chamada real e recebe 200',async()=>{
  offset+=11000;fault=false;
  await page.evaluate(()=>{window.statusClockOffset+=11000;});
  await page.waitForFunction(()=>!document.querySelector('#whatsappRefresh').disabled);
  assert.equal(upstream,1,'Expiration does not auto retry');
  const r=page.waitForResponse(r=>r.url().endsWith('/whatsapp/status'));
  await page.evaluate(()=>{const b=document.querySelector('#whatsappRefresh');b.click();b.dispatchEvent(new MouseEvent('click'));});
  assert.equal((await r).status(),200);await page.waitForFunction(()=>document.querySelector('#whatsappState').textContent.includes('WhatsApp conectado'));
  assert.equal(upstream,2);
 });
 await t.test('consultas HTTP concorrentes compartilham uma chamada de estado',async()=>{
  offset+=10001; // Expire the shared status cache before testing in-flight deduplication.
  const before=upstream,received=logs.filter(e=>e.event==='STATUS_REQUEST_RECEIVED').length;
  let release;responseGate=new Promise(resolve=>{release=resolve;});
  const pending=Promise.all([api(route,token),api(route,token),api(route,token)]);
  try {
   const deadline=realNow()+10000;
   while(logs.filter(e=>e.event==='STATUS_REQUEST_RECEIVED').length<received+3&&realNow()<deadline)await new Promise(r=>setTimeout(r,10));
   assert.equal(logs.filter(e=>e.event==='STATUS_REQUEST_RECEIVED').length,received+3);
  } finally {release();responseGate=null;}
  const responses=await pending;
  assert.ok(responses.every(r=>r.status===200));assert.equal(upstream,before+1);
 });
 await t.test('sucesso limpa historico do backoff; novo 429 sem header comeca em 30',async()=>{
  const guard=require('../evolutionConnectionGuard');const key='https://status-only.test|status-fixture';
  const fresh=guard.recordRateLimit(key,null);assert.equal(fresh.retryAfterSeconds,30);assert.equal(fresh.localBackoffSeconds,30);
 });
 await t.test('trilha diferencia recebimento, bloqueio local, transporte e resposta sem segredo',async()=>{
  for(const event of ['STATUS_REQUEST_RECEIVED','STATUS_BLOCKED_BY_LOCAL_COOLDOWN','STATUS_CALLING_EVOLUTION','STATUS_EVOLUTION_RESPONSE'])assert.ok(logs.some(e=>e.event===event),event);
  assert.equal(logs.filter(e=>e.event==='STATUS_CALLING_EVOLUTION').length,upstream);
  const text=JSON.stringify(logs.filter(e=>e.event?.startsWith('STATUS_')));assert.ok(!text.includes(token));assert.ok(!text.includes(process.env.EVOLUTION_API_KEY));
 });
});
