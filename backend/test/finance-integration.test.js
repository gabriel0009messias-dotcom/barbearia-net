const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const fs=require('node:fs');
const puppeteer=require('puppeteer');

test('Financeiro integrado: sessão, preço histórico e painel responsivo',async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 process.env.MERCADO_PAGO_ACCESS_TOKEN='';process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';
 const db=require('../database');await db.ready;
 const app=express();app.use(express.json());app.use('/api',require('../routes'));
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(url,token,body,method=body?'POST':'GET')=>{
  const response=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json(),cache:response.headers.get('cache-control')};
 };
 const owners=[];
 for(let i=0;i<2;i++){
  const email=`finance-${i}@example.test`;
  const signup=await request('/publico/assinaturas',null,{barbeariaNome:'Financeiro '+i,responsavelNome:'Ana',telefone:'1199999000'+i,email,senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Corte',preco:30}]});
  assert.equal(signup.status,201);
  const id=signup.data.assinatura.id;
  await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2099-01-01',weekly_hours=$1 WHERE id=$2",[JSON.stringify(Array.from({length:7},()=>[['08:00','18:00']])),id]);
  const login=await request('/barbeiro/login',null,{identificador:email,senha:'test-password'});
  const panel=await request('/studiofy/painel',login.data.token);
  owners.push({id,token:login.data.token,service:panel.data.servicos[0],professional:panel.data.profissionais[0].id});
 }
 const [a,b]=owners;
 const future=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
 const book=async(owner,hour,name)=>{
  const r=await request('/studiofy/agendamentos',owner.token,{nome_cliente:name,telefone:'11999991111',data:future,hora:hour,servico_id:owner.service.id,profissional_id:owner.professional});
  assert.equal(r.status,201);return r.data.id;
 };
 let original, other;
 await t.test('preço 30 permanece após catálogo mudar para 40; futuras concluídas não faturam',async()=>{
  original=await book(a,'08:00','Cliente histórico');
  const changed=await request('/studiofy/servicos/'+a.service.id,a.token,{...a.service,preco:40},'PUT');assert.equal(changed.status,200);
  assert.equal((await db.getAsync('SELECT preco FROM agendamentos WHERE id=$1',[original])).preco,30);
  assert.equal((await request('/studiofy/agendamentos/'+original,a.token,{status:'concluido'},'PATCH')).status,409);
  assert.equal((await request('/studiofy/painel',a.token)).data.financeiro.total.valor_centavos,0);
  // Move this test fixture into the past without changing its saved price.
  await db.runAsync('UPDATE agendamentos SET data=$1,hora=$2 WHERE id=$3',[today,'00:00',original]);
  assert.equal((await request('/studiofy/agendamentos/'+original,a.token,{status:'concluido'},'PATCH')).status,200);
  const newer=await book(a,'09:00','Cliente novo');
  assert.equal((await db.getAsync('SELECT preco FROM agendamentos WHERE id=$1',[newer])).preco,40);
  await db.runAsync("UPDATE agendamentos SET status='concluido',data=$1,hora='00:00' WHERE id=$2",[today,newer]);
  const cancelled=await book(a,'10:00','Cancelado invisível');
  await db.runAsync("UPDATE agendamentos SET status='cancelado',data=$1 WHERE id=$2",[today,cancelled]);
  await book(a,'11:00','Confirmado futuro');
  const f=(await request('/studiofy/painel',a.token)).data.financeiro;
  assert.equal(f.hoje.valor_centavos,7000);assert.equal(f.semana.valor_centavos,7000);assert.equal(f.mes.valor_centavos,7000);
  assert.equal(f.total.atendimentos,2);assert.equal(f.servicos[0].valor_centavos,7000);
  assert.equal(f.historico.find(x=>x.id===original).valor_centavos,3000);
 });
 await t.test('backend autentica e ignora estabelecimento forjado; dados financeiros não vazam',async()=>{
  other=await book(b,'08:00','Cliente exclusivo B');
  await db.runAsync("UPDATE agendamentos SET status='concluido',preco=1250,data=$1,hora='00:00' WHERE id=$2",[today,other]);
  assert.equal((await request('/studiofy/painel')).status,401);
  assert.equal((await request('/studiofy/painel','forged')).status,401);
  const response=await request('/studiofy/painel?assinatura_id='+b.id+'&salon_id='+b.id,a.token);
  assert.equal(response.cache,'no-store');assert.equal(response.data.financeiro.total.valor_centavos,7000);
  assert.ok(!JSON.stringify(response.data.financeiro).includes('Cliente exclusivo B'));
  const otherPanel=await request('/studiofy/painel',b.token);
  assert.equal(otherPanel.data.financeiro.total.valor_centavos,125000);
  assert.ok(!otherPanel.data.financeiro.historico.some(x=>x.id===original));
 });
 await t.test('Agenda mantém faturamento nas telas publicadas de Financeiro, Relatórios e Clientes',async()=>{
  const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
   await page.goto(base+'/login.html');await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),a.token);
   await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="Financeiro"]');
   for(const width of [1440,390,320]){
    await page.setViewport({width,height:900});await page.click('[data-section="Financeiro"]');await page.waitForSelector('#view table');
    assert.match(await page.$eval('#view',e=>e.textContent),/R\$\s70,00/);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.click('[data-section="Relatórios"]');assert.match(await page.$eval('#view',e=>e.textContent),/Corte/);assert.match(await page.$eval('#view',e=>e.textContent),/R\$\s70,00/);
    await page.click('[data-section="Clientes"]');assert.match(await page.$eval('#view',e=>e.textContent),/Cliente novo/);assert.doesNotMatch(await page.$eval('#view',e=>e.textContent),/Cliente exclusivo B|Cancelado invisível|Confirmado futuro/);
    assert.equal(await page.$$eval('#view tbody tr',els=>els.length),1);assert.equal(await page.$eval('#view tbody tr td:last-child',e=>e.textContent),'2');
   }
   await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),b.token);await page.reload();await page.waitForSelector('[data-section="Financeiro"]');await page.click('[data-section="Financeiro"]');
   assert.match(await page.$eval('#view',e=>e.textContent),/R\$\s1\.250,00/);
   assert.equal((await request('/studiofy/agendamentos/'+other,b.token,{status:'cancelado'},'PATCH')).status,409);
   assert.equal((await request('/studiofy/painel',b.token)).data.financeiro.total.valor_centavos,125000);
   // Only this isolated fixture is deleted to exercise the unchanged empty screen.
   await db.runAsync('DELETE FROM agendamentos WHERE assinatura_id=$1',[b.id]);await page.reload();await page.waitForSelector('[data-section="Financeiro"]');await page.click('[data-section="Financeiro"]');
   assert.match(await page.$eval('#view',e=>e.textContent),/Nenhum registro/);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
});
