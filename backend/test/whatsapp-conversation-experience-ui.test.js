const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const express=require('express'),path=require('path'),fs=require('fs'),puppeteer=require('puppeteer');
const {fixture}=require('./helpers/conversation');
test('WhatsApp to authenticated Studiofy: contact before booking, immediate Agenda, snapshots and UI details', {timeout:90000}, async t=>{
 const env=require('./helpers/postgres').testEnvironment();process.env.EVOLUTION_WEBHOOK_SECRET='conversation-test-secret';
 const db=require('../database');await db.ready;
 const app=express();app.use(express.json());app.use('/api',require('../routes'));app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await db.close();await env.cleanup();});
 const base='http://127.0.0.1:'+server.address().port;
 const req=async(url,token,body)=>{const r=await fetch(base+'/api'+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{'x-barbeiro-token':token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 const f=await fixture(db,{known:false}),other=await fixture(db,{known:false});
 const salt=crypto.randomBytes(16).toString('hex'),hash=crypto.scryptSync('synthetic-test-password',salt,64).toString('hex');
 await db.runAsync("UPDATE assinaturas SET email='experience-owner@example.test',senha_hash=$1,senha_salt=$2 WHERE id=$3",[hash,salt,f.tenant]);
 await f.send('uma frase qualquer');await f.send('Contato Principal');await other.send('oi');await other.send('Outro Tenant');
 const login=await req('/barbeiro/login',null,{identificador:'experience-owner@example.test',senha:'synthetic-test-password'});assert.equal(login.status,200);const token=login.data.token;
 assert.equal((await req('/studiofy/painel')).status,401);
 let panel=await req('/studiofy/painel?assinatura_id='+other.tenant,token);assert.equal(panel.status,200);assert.deepEqual(panel.data.clientes.map(c=>c.nome),['Contato Principal']);assert.equal(panel.data.agendamentos.length,0);
 const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
  await page.goto(base+'/login.html');await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),token);await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="Clientes"]');await page.click('[data-section="Clientes"]');
  await page.waitForFunction(()=>document.body.textContent.includes('Contatos cadastrados'));assert.match(await page.$eval('body',e=>e.textContent),/Contato Principal/);assert.doesNotMatch(await page.$eval('body',e=>e.textContent),/Outro Tenant/);
  await f.review();await f.send('6');await f.send('Pessoa Beneficiária');await f.send('5');await f.send('Observação da reserva');await f.send('1',{drain:false});
  panel=await req('/studiofy/painel',token);assert.equal(panel.data.agendamentos.length,1);const a=panel.data.agendamentos[0];assert.equal(a.nome_cliente,'Pessoa Beneficiária');assert.equal(a.telefone,f.phone);assert.equal(a.origem,'whatsapp');assert.equal(a.observacao,'Observação da reserva');assert.equal(panel.data.clientes[0].nome,'Contato Principal');
  await page.reload();await page.waitForSelector('[data-section="Agendamentos"]');await page.click('[data-section="Agendamentos"]');await page.click('[data-agenda-filter="proximos"]');await page.waitForSelector(`[data-view-booking="${a.id}"]`);await page.click(`[data-view-booking="${a.id}"]`);
  const detail=await page.$eval('dialog',e=>e.textContent);for(const value of ['Pessoa Beneficiária',f.phone,'Massagem','João','WhatsApp','Observação da reserva'])assert.ok(detail.includes(value),value);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
