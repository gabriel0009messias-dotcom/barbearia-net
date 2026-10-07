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
  const futureCompleted=await book(a,'12:00','Concluído futuro');
  await db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1",[futureCompleted]);
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
 await t.test('legado faturamento: autenticação real, isolamento, no-store e mesmo resumo do painel',async()=>{
  assert.equal((await request('/faturamento?periodo=dia')).status,401);
  assert.equal((await request('/faturamento?periodo=dia','forged')).status,401);
  const panel=(await request('/studiofy/painel',a.token)).data.financeiro;
  for(const [selector,summary] of [['dia','hoje'],['hoje','hoje'],['semana','semana'],['mes','mes'],['total','total']]){
   const res=await request('/faturamento?periodo='+selector+'&assinatura_id='+b.id,a.token);
   assert.equal(res.status,200);assert.equal(res.cache,'no-store');
   assert.deepEqual(res.data,{total:panel[summary].valor_centavos/100});
  }
  assert.deepEqual((await request('/faturamento?periodo=total',b.token)).data,{total:1250});
  assert.deepEqual((await request('/faturamento?periodo=mes_customizado&mes='+today.slice(0,7),a.token)).data,{total:70});
  assert.deepEqual((await request('/faturamento?periodo=mes&mes=2000-01',a.token)).data,{total:0});
  for(const suffix of ['?periodo=desconhecido','?periodo=mes_customizado','?periodo=mes&mes=2026-13']){
   assert.equal((await request('/faturamento'+suffix,a.token)).status,400);
  }
 });
 await t.test('legado: falha SQL na autenticação não expõe mensagem interna',async subtest=>{
  subtest.mock.method(db,'get',(sql,params,callback)=>callback(Object.assign(new Error('XX000: private auth SQL diagnostic'),{code:'XX000'})));
  const response=await request('/faturamento?periodo=dia',a.token);
  assert.deepEqual(response,{status:500,cache:'no-store',data:{error:'Não foi possível consultar o faturamento.'}});
 });
 await t.test('legado: falha SQL na consulta financeira tem resposta genérica',async subtest=>{
  const originalAll=db.allAsync;
  subtest.mock.method(db,'allAsync',async function(sql,...args){
   if(sql==='SELECT * FROM agendamentos WHERE assinatura_id=$1')throw new Error('XX000: private financial SQL diagnostic');
   return originalAll.call(this,sql,...args);
  });
  const response=await request('/faturamento?periodo=dia',a.token);
  assert.deepEqual(response,{status:500,cache:'no-store',data:{error:'Não foi possível consultar o faturamento.'}});
 });
 await t.test('painel ignora histórico inválido; serviço sem nome não causa HTTP 500',async()=>{
  const fixtures=[{data:future,preco:40},{data:'2026-02-30',preco:999},{hora:'25:99',preco:999},
   {hora:null,preco:999},{preco:null},{preco:-10},{preco:NaN},{preco:Infinity},{preco:1.005},
   {preco:0,servico:null},{preco:0,servico:'Corte'}];
  const ids=[];
  try{
   for(const f of fixtures){
    const result=await db.runAsync("INSERT INTO agendamentos (assinatura_id,nome_cliente,data,hora,status,preco,servico_nome) VALUES ($1,'Legado financeiro',$2,$3,'concluido',$4,$5)",
     [a.id,f.data??today,Object.hasOwn(f,'hora')?f.hora:'00:00',f.preco,Object.hasOwn(f,'servico')?f.servico:'Legado']);
    ids.push(result.lastID);
   }
   const response=await request('/studiofy/painel',a.token);
   assert.equal(response.status,200);assert.equal(response.data.financeiro.total.valor_centavos,7000);
   assert.equal(response.data.financeiro.total.atendimentos,4); // Two valid zero-priced rows.
   assert.ok(response.data.financeiro.historico.some(x=>x.servico==='Serviço não identificado'));
   assert.deepEqual((await request('/faturamento?periodo=total',a.token)).data,{total:70});
   assert.equal((await db.getAsync('SELECT servico_nome FROM agendamentos WHERE id=$1',[ids[9]])).servico_nome,null);
   assert.equal((await db.getAsync('SELECT preco FROM agendamentos WHERE id=$1',[ids[4]])).preco,null);
  }finally{
   for(const id of ids)await db.runAsync('DELETE FROM agendamentos WHERE id=$1 AND assinatura_id=$2',[id,a.id]);
  }
 });
 await t.test('Chromium: indicadores, serviços, histórico, reais e telas móvel/desktop',async()=>{
  const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
  assert.ok(executablePath,'Chromium é necessário para validar o financeiro');
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setRequestInterception(true);
   page.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
   await page.goto(base+'/login.html');await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),a.token);
   await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="Financeiro"]');
   await page.click('[data-section="Financeiro"]');await page.waitForSelector('[data-finance="hoje"]');
   for(const width of [1440,390,320]){
    await page.setViewport({width,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Página deve caber na largura '+width);
    for(const period of ['hoje','semana','mes'])assert.match(await page.$eval(`[data-finance="${period}"] .stat`,e=>e.textContent),/R\$\s70,00/);
    assert.equal(await page.$eval('[data-finance="total"] .stat',e=>e.textContent),'2');
    assert.match(await page.$eval('#financeServices',e=>e.textContent),/Corte/);
    const history=await page.$eval('#financeHistory',e=>e.textContent);
    assert.match(history,/Cliente histórico/);assert.match(history,/R\$\s30,00/);assert.match(history,/R\$\s40,00/);
    assert.doesNotMatch(history,/Cancelado invisível|Confirmado futuro|Concluído futuro|Cliente exclusivo B/);
    await page.click('[data-section="Dashboard"]');
    assert.match(await page.$eval('[data-dashboard="revenue-today"] .stat',e=>e.textContent),/70,00/);
    await page.click('[data-section="Relatórios"]');
    const reports=await page.$eval('#view',e=>e.textContent);
    assert.match(reports,/70,00/);assert.doesNotMatch(reports,/110,00/);
    await page.click('[data-section="Clientes"]');
    const clients=await page.$eval('#view',e=>e.textContent);
    assert.match(clients,/Cliente novo/);
    assert.doesNotMatch(clients,/Cliente exclusivo B|Cancelado invisível|Confirmado futuro|Concluído futuro/);
    assert.equal(await page.$$eval('#view tbody tr',els=>els.length),1);
    assert.equal(await page.$eval('#view tbody tr td:last-child',e=>e.textContent),'2');
    await page.click('[data-section="Financeiro"]');
   }
   await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),b.token);await page.reload();
   await page.waitForSelector('[data-section="Financeiro"]');await page.click('[data-section="Financeiro"]');
   assert.match(await page.$eval('[data-finance="hoje"] .stat',e=>e.textContent),/R\$\s1\.250,00/);
   assert.equal((await request('/studiofy/agendamentos/'+other,b.token,{status:'cancelado'},'PATCH')).status,409);
   assert.equal((await request('/studiofy/painel',b.token)).data.financeiro.total.valor_centavos,125000);
   // Clear this isolated fixture to exercise an empty account; finalized revenue cannot be cancelled away.
   await db.runAsync('DELETE FROM agendamentos WHERE assinatura_id=$1',[b.id]);
   await page.reload();await page.waitForSelector('[data-section="Financeiro"]');await page.click('[data-section="Financeiro"]');
   assert.match(await page.$eval('[data-finance="hoje"] .stat',e=>e.textContent),/R\$\s0,00/);
   assert.match(await page.$eval('#financeHistory',e=>e.textContent),/Nenhum registro/);
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
});
