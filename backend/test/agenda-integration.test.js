const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const {localMoment}=require('../services/agenda');

test('Agenda: filtros, conclusão segura, profissionais, financeiro e responsividade',async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 process.env.MERCADO_PAGO_ACCESS_TOKEN='';process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';
 const db=require('../database');await db.ready;
 const app=express();app.use(express.json());app.use('/api',require('../routes'));app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(url,token,body,method=body?'POST':'GET')=>{
  const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json()};
 };
 const owners=[];
 for(let i=0;i<2;i++){
  const email=`agenda-${i}@example.test`;
  const signup=await req('/publico/assinaturas',null,{barbeariaNome:'Agenda '+i,responsavelNome:'Ana',telefone:'1199999300'+i,email,senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Corte',preco:30}]});
  assert.equal(signup.status,201);const id=signup.data.assinatura.id;
  await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2099-01-01',weekly_hours=$1 WHERE id=$2",[JSON.stringify(Array.from({length:7},()=>[['08:00','18:00']])),id]);
  const login=await req('/barbeiro/login',null,{identificador:email,senha:'test-password'});
  const panel=(await req('/studiofy/painel',login.data.token)).data;
  owners.push({id,token:login.data.token,professional:panel.profissionais[0].id,service:panel.servicos[0]});
 }
 const [a,b]=owners;
 const second=await req('/studiofy/profissionais',a.token,{nome:'Beatriz',ativo:true,servicos:[a.service.id]});assert.equal(second.status,200);
 const today=localMoment().date;
 const shift=n=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 const insert=async(owner,date,hour,name,status='confirmado',professional=owner.professional,price=30)=>(await db.runAsync(
  'INSERT INTO agendamentos (assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,profissional_id,duracao,studio_service_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,30,$9,$10)',
  [owner.id,name,'5511999993333','Corte',price,date,hour,professional,owner.service.id,status])).lastID;
 // Intentionally insert out of order to prove chronological output.
 const afternoon=await insert(a,today,'14:00','Cliente 14');
 const cancelled=await insert(a,today,'10:00','Cliente cancelado','cancelado');
 const early=await insert(a,today,'08:00','Cliente 08');
 const middle=await insert(a,today,'09:30','Cliente 09');
 const tomorrowA=await insert(a,shift(1),'08:00','Amanhã Ana');
 const tomorrowB=await insert(a,shift(1),'08:00','Amanhã Beatriz','confirmado',second.data.id);
 const past=await insert(a,shift(-1),'08:00','Cliente concluir');
 const viaUI=await insert(a,shift(-1),'09:00','Cliente concluir na tela','confirmado',a.professional,40);
 const foreign=await insert(b,shift(-1),'08:00','Cliente exclusivo de outro estabelecimento');

 await t.test('sessão, ordem cronológica, profissionais e isolamento de leitura/escrita',async()=>{
  assert.equal((await req('/studiofy/painel')).status,401);
  const panel=(await req('/studiofy/painel?assinatura_id='+b.id,a.token)).data;
  assert.equal(panel.agenda.hoje,today);
  assert.deepEqual(panel.agendamentos.filter(x=>x.data===today).map(x=>x.id),[early,middle,cancelled,afternoon]);
  assert.equal(panel.agendamentos.find(x=>x.id===tomorrowB).profissional,'Beatriz');
  assert.ok(!panel.agendamentos.some(x=>x.id===foreign));
  assert.equal((await req('/studiofy/agendamentos/'+foreign,a.token,{status:'concluido',assinatura_id:b.id},'PATCH')).status,404);
  assert.equal((await req('/studiofy/agendamentos/'+foreign,a.token,{assinatura_id:b.id},'PUT')).status,404);
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[foreign])).status,'confirmado');
 });
 await t.test('backend recusa conclusão futura, cancelada e status inválido sem aumentar receita',async()=>{
  for(const id of [tomorrowA,tomorrowB,cancelled]){
   const response=await req('/studiofy/agendamentos/'+id,a.token,{status:'concluido',data:shift(-1),pode_concluir:true},'PATCH');
   assert.equal(response.status,409);
  }
  assert.equal((await req('/studiofy/agendamentos/'+past,a.token,{status:'inexistente'},'PATCH')).status,400);
  assert.equal((await req('/studiofy/painel',a.token)).data.financeiro.total.valor_centavos,0);
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[tomorrowA])).status,'confirmado');
 });
 await t.test('concluir válido preserva preço histórico e inclui uma vez no financeiro',async()=>{
  assert.equal((await req('/studiofy/servicos/'+a.service.id,a.token,{...a.service,preco:90},'PUT')).status,200);
  const responses=await Promise.all([1,2].map(()=>req('/studiofy/agendamentos/'+past,a.token,{status:'concluido',assinatura_id:b.id},'PATCH')));
  assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);
  const panel=(await req('/studiofy/painel',a.token)).data;
  assert.equal(panel.agendamentos.find(x=>x.id===past).status,'concluido');
  assert.equal(panel.financeiro.total.valor_centavos,3000);assert.equal(panel.financeiro.total.atendimentos,1);
  assert.equal((await db.getAsync('SELECT preco FROM agendamentos WHERE id=$1',[past])).preco,30);
  assert.equal((await req('/studiofy/painel',b.token)).data.financeiro.total.valor_centavos,0);
 });
 await t.test('navegador: filtros, detalhes, conclusão e calendário separado por profissional',async()=>{
  const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
   await page.goto(base+'/login.html');await page.evaluate(token=>localStorage.setItem('barbearia_auth_token',token),a.token);
   await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="Agendamentos"]');await page.click('[data-section="Agendamentos"]');
   const ids=()=>page.$$eval('[data-agenda-booking]',els=>els.map(e=>Number(e.dataset.agendaBooking)));
   const filter=async key=>{await page.click(`[data-agenda-filter="${key}"]`);};
   const folder=path.resolve(__dirname,'../../.tmp/agenda-validation');fs.mkdirSync(folder,{recursive:true});
   for(const width of [1440,768,390]){
    await page.setViewport({width,height:950});await filter('hoje');
    assert.deepEqual(await ids(),[early,middle,cancelled,afternoon]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.match(await page.$eval(`[data-agenda-booking="${early}"]`,e=>e.textContent),/Agendado/);
    assert.match(await page.$eval(`[data-agenda-booking="${cancelled}"]`,e=>e.textContent),/Cancelado/);
    await page.click(`[data-view-booking="${early}"]`);await page.waitForSelector('.agenda-dialog[open]');
    const details=await page.$eval('.agenda-dialog',e=>e.textContent);assert.match(details,/Cliente 08/);assert.match(details,/Ana/);assert.match(details,/R\$\s30,00/);
    await page.click('.agenda-dialog button');
    await page.screenshot({path:path.join(folder,`agenda-${width}.png`),fullPage:true});
    await filter('proximos');
    const expected=(await req('/studiofy/painel',a.token)).data.agendamentos.filter(x=>x.futuro&&x.status==='confirmado').map(x=>x.id);
    assert.deepEqual(await ids(),expected);
    assert.equal(await page.$(`[data-status="${tomorrowA}"] option[value="concluido"]`),null);
    await page.select('#agendaProfessional',String(second.data.id));assert.deepEqual(await ids(),[tomorrowB]);
    await page.select('#agendaProfessional','');await filter('cancelados');assert.deepEqual(await ids(),[cancelled]);
    await filter('concluidos');assert.deepEqual(await ids(),[past]);
   }
   await filter('todos');page.once('dialog',dialog=>dialog.accept());await page.select(`[data-status="${viaUI}"]`,'concluido');
   await page.waitForFunction(id=>document.querySelector(`[data-agenda-booking="${id}"] .status-concluido`),{},viaUI);
   await page.click('[data-section="Financeiro"]');await page.waitForSelector('#view table');
   assert.match(await page.$eval('#view',e=>e.textContent),/R\$\s70,00/);
   await page.click('[data-section="Agendamentos"]');await page.click('#agendaMode');
   for(let i=0;i<2&&!await page.$(`[data-calendar-booking="${tomorrowB}"]`);i++)await page.click('#nextWeek');
   const boxes=await page.evaluate(([a,b])=>[a,b].map(id=>{const r=document.querySelector(`[data-calendar-booking="${id}"]`).getBoundingClientRect();return {left:r.left,right:r.right};}),[tomorrowA,tomorrowB]);
   assert.ok(boxes[0].right<=boxes[1].left || boxes[1].right<=boxes[0].left,'Profissionais simultâneos não se sobrepõem');
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 });
 await t.test('consulta de remarcação respeita duração histórica e valida IDs e estabelecimento',async()=>{
  const id=await insert(a,shift(2),'08:00','Reserva com duração histórica');
  await db.runAsync('UPDATE agendamentos SET duracao=60 WHERE id=$1',[id]);
  const url='/studiofy/horarios?'+new URLSearchParams({data:shift(2),servico_id:a.service.id,profissional_id:a.professional,excluir_id:id});
  const slots=await req(url,a.token);assert.equal(slots.status,200);
  assert.ok(slots.data.includes('17:00'));assert.ok(!slots.data.includes('17:30'));
  assert.equal((await req(url,b.token)).status,404);
  assert.equal((await req(url.replace('excluir_id='+id,'excluir_id=abc'),a.token)).status,400);
  assert.equal((await req(url.replace('servico_id='+a.service.id,'servico_id=abc'),a.token)).status,400);
  assert.equal((await req(url.replace('profissional_id='+a.professional,'profissional_id=abc'),a.token)).status,400);
 });
});
