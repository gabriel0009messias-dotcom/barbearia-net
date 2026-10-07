const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const {appointmentPermissions,localMoment}=require('../services/agenda');
const {financialSummary}=require('../services/finance');

test('Agenda etapa 2: filtros, calendário, horários, ações e telas responsivas',{timeout:120000},async t=>{
 const instant='2026-10-31T15:00:00Z',moment=localMoment(new Date(instant));
 const longName='Cliente '+ 'NomeMuitoLongo'.repeat(16)+' <img src=x onerror="window.agendaXss=true">';
 const originals=[
  [1,'2026-10-31','13:00','confirmado',1,longName],
  [2,'2026-10-31','10:00','confirmado',2,'Confirmado passado'],
  [3,'2026-10-31','09:00','concluido',1,'Concluído histórico'],
  [4,'2026-10-30','11:00','cancelado',2,'Cancelado histórico'],
  [5,'2026-10-31','11:00','falta',2,'Falta de hoje'],
  [6,'2026-11-01','09:00','confirmado',1,'Confirmado amanhã'],
  [7,'2026-11-02','10:00','concluido',2,'Concluído futuro inválido'],
  [8,'2026-10-29','14:00','concluido',2,'Concluído anterior'],
  [9,'2026-10-31','08:00','cancelado',1,'Cancelado hoje'],
  [10,'2026-02-30','09:00','concluido',2,'Data inválida histórica'],
 ].map(([id,data,hora,status,profissional_id,nome_cliente])=>({id,data,hora,status,profissional_id,nome_cliente,
  telefone:'5511999991234',servico_nome:'Serviço '+ 'DescriçãoLonga'.repeat(12),preco:1250.5,duracao:90,
  studio_service_id:1,profissional:profissional_id===1?'Profissional '+ 'NomeLongo'.repeat(18):'Beatriz',
  campo_interno:'internal-field-must-not-render'}));
 let rows,slotMode,slotCalls,slotDates,activeSlots,maxSlots,mutationMode,mutationCalls,mutationBodies;
 const pending=new Set();
 const reset=()=>{rows=structuredClone(originals);slotMode='ok';slotCalls=0;slotDates=[];activeSlots=0;maxSlots=0;mutationMode='ok';mutationCalls=0;mutationBodies=[];};reset();
 const payload=()=>({pagina:{nome:'Agenda teste',slug:'agenda-test'},agenda:{hoje:moment.date},
  agendamentos:rows.map(a=>({...a,...appointmentPermissions(a,moment)})),
  profissionais:[{id:1,nome:originals[0].profissional,ativo:true,servicos:[1]},{id:2,nome:'Beatriz',ativo:true,servicos:[1]},{id:3,nome:'Sem reservas',ativo:true,servicos:[1]}],
  servicos:[{id:1,nome:originals[0].servico_nome,ativo:true,preco:2000,duracao:30}],
  bloqueios:[],lembretes:[],financeiro:financialSummary(rows,new Date(instant))});
 const app=express();app.use(express.json());
 app.get('/api/barbeiro/me',(_req,res)=>res.json({id:1,barbearia_nome:'Agenda teste',acesso:{liberado:true,status:'subscription_active'}}));
 app.get('/api/studiofy/painel',(_req,res)=>res.json(payload()));
 app.get('/api/studiofy/horarios',async(req,res)=>{
  slotCalls++;slotDates.push(req.query.data);activeSlots++;maxSlots=Math.max(maxSlots,activeSlots);
  let ended=false;const end=()=>{if(!ended){ended=true;activeSlots--;}};res.once('close',end);
  if(slotMode==='delay')await new Promise(resolve=>{const release=()=>{pending.delete(release);resolve();};pending.add(release);});
  if(slotMode==='hang')return;
  if(slotMode==='error')return res.status(503).json({error:'Falha temporária na consulta de horários.'});
  if(slotMode==='malformed')return res.json({horarios:'invalid-contract'});
  res.json(['09:00','13:00','15:00']);
 });
 const mutate=async(req,res)=>{
  mutationCalls++;mutationBodies.push({...req.body});
  if(mutationMode==='delay')await new Promise(resolve=>{const release=()=>{pending.delete(release);resolve();};pending.add(release);});
  if(mutationMode==='error')return res.status(409).json({error:'O estado do agendamento mudou. Atualize a Agenda.'});
  const row=rows.find(a=>a.id===Number(req.params.id));
  if(row)Object.assign(row,req.body);
  res.json({ok:true,id:row?.id || 11});
 };
 app.patch('/api/studiofy/agendamentos/:id',mutate);app.put('/api/studiofy/agendamentos/:id',mutate);app.post('/api/studiofy/agendamentos',mutate);
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{for(const release of pending)release();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`,page=await browser.newPage(),errors=[];
 const screenshots=path.resolve(__dirname,'../../.tmp/agenda-stage2-validation');fs.mkdirSync(screenshots,{recursive:true});
 page.on('pageerror',error=>errors.push(error.message));
 await page.evaluateOnNewDocument(fixed=>{
  const OriginalDate=Date;window.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return new OriginalDate(fixed).getTime();}};
  localStorage.setItem('barbearia_auth_token','synthetic-agenda-session');
  // Accelerate only the existing request deadline; production retains its 20-second limit.
  const timeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timeout(fn,ms===20000?600:ms,...args);
 },instant);
 await page.emulateTimezone('Pacific/Kiritimati');
 await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)?r.continue():r.respond({status:200,contentType:'application/json',body:'{}'}));
 const open=async()=>{await page.goto(base+'/studiofy.html');await page.waitForSelector('[data-section="Agendamentos"]');await page.click('[data-section="Agendamentos"]');};
 const filter=key=>page.click(`[data-agenda-filter="${key}"]`);
 const ids=()=>page.$$eval('[data-agenda-booking]',els=>els.map(e=>Number(e.dataset.agendaBooking)));
 const expected=predicate=>rows.filter(predicate).sort((a,b)=>(a.data+a.hora).localeCompare(b.data+b.hora)||a.id-b.id).map(a=>a.id);
 const newForm=async()=>{await page.click('#newBooking');await page.waitForSelector('#editor');};
 const slotsDone=()=>page.waitForFunction(()=>document.querySelector('[name=hora]').getAttribute('aria-busy')==='false');
 const closeDetails=()=>page.click('[data-close-details]');
 await open();

 await t.test('Hoje inclui todos os status datados hoje e botão superior ativa o filtro na lista',async()=>{
  await filter('hoje');assert.deepEqual(await ids(),[9,3,2,5,1]);
  for(const status of ['confirmado','concluido','cancelado','falta'])assert.ok(await page.$('.agenda-list .status-'+status));
  await filter('cancelados');await page.click('#agendaToday');assert.deepEqual(await ids(),[9,3,2,5,1]);
  assert.equal(await page.$eval('[data-agenda-filter="hoje"]',e=>e.getAttribute('aria-pressed')),'true');
 });
 await t.test('Próximos somente confirmados futuros; concluídos exclui futuro e data inválida',async()=>{
  await filter('proximos');assert.deepEqual(await ids(),[1,6]);
  await filter('concluidos');assert.deepEqual(await ids(),[8,3]);
 });
 await t.test('Cancelados conserva histórico; Todos conserva faltas e registros legados',async()=>{
  await filter('cancelados');assert.deepEqual(await ids(),[4,9]);
  await filter('todos');assert.deepEqual(await ids(),expected(()=>true));assert.ok(await page.$('[data-agenda-booking="5"] .status-falta'));
 });
 await t.test('profissional combina com cada filtro e permanece no calendário',async()=>{
  const predicates={hoje:a=>a.data===moment.date,proximos:a=>[1,6].includes(a.id),concluidos:a=>[3,8].includes(a.id),cancelados:a=>a.status==='cancelado',todos:()=>true};
  await page.select('#agendaProfessional','2');
  for(const [key,predicate]of Object.entries(predicates)){await filter(key);assert.deepEqual(await ids(),expected(a=>a.profissional_id===2&&predicate(a)));}
  await page.click('#agendaMode');assert.equal(await page.$eval('#agendaProfessional',e=>e.value),'2');
  assert.deepEqual(await page.$$eval('[data-calendar-booking]',els=>els.map(e=>+e.dataset.calendarBooking).sort()),[2,5,8]);
  await page.select('#agendaProfessional','');
 });
 await t.test('calendário usa São Paulo em dispositivo UTC+14, com viradas de mês e ano',async()=>{
  assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/outubro de 2026/i);
  assert.deepEqual(await page.$$eval('.calendar-day',els=>els.map(e=>e.dataset.agendaDate)),['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01']);
  assert.match(await page.$eval('.calendar-day[data-agenda-date="2026-10-31"]',e=>e.textContent),/sáb/i);
  await page.click('#nextWeek');assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/novembro de 2026/i);
  await page.click('#prevWeek');assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/outubro de 2026/i);
  for(let i=0;i<9;i++)await page.click('#nextWeek');
  assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/janeiro de 2027/i);
  assert.deepEqual(await page.$$eval('.calendar-day',els=>els.map(e=>e.dataset.agendaDate)),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
  await page.click('#prevWeek');assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/dezembro de 2026/i);
  await page.click('#agendaToday');assert.match(await page.$eval('.agenda-toolbar h2',e=>e.textContent),/outubro de 2026/i);
 });
 await t.test('seleção no calendário abre detalhes do dia certo e só remarca confirmado futuro',async()=>{
  await page.click('[data-calendar-booking="6"]');await page.waitForSelector('.agenda-dialog[open]');
  assert.match(await page.$eval('.agenda-dialog',e=>e.textContent),/01\/11\/2026 · 09:00/);
  await page.click('[data-detail-reschedule]');assert.equal(await page.$eval('[name=data]',e=>e.value),'2026-11-01');
  await slotsDone();await page.click('#cancel');
  await page.click('[data-calendar-booking="3"]');await page.waitForSelector('.agenda-dialog[open]');assert.equal(await page.$('[data-detail-reschedule]'),null);await closeDetails();
 });
 await t.test('ações por status: futuros só cancelam/remarcam; passados concluem ou registram falta; finais só visualizam',async()=>{
  await filter('todos');
  assert.deepEqual(await page.$$eval('[data-status="1"] option',els=>els.map(e=>e.value)),['','cancelado']);assert.ok(await page.$('[data-reschedule="1"]'));
  assert.deepEqual(await page.$$eval('[data-status="2"] option',els=>els.map(e=>e.value)),['','cancelado','concluido','falta']);assert.equal(await page.$('[data-reschedule="2"]'),null);
  for(const id of [3,4,5,7,8,9,10]){assert.equal(await page.$(`[data-status="${id}"]`),null);assert.equal(await page.$(`[data-reschedule="${id}"]`),null);assert.ok(await page.$(`[data-view-booking="${id}"]`));}
 });
 await t.test('detalhes exibem campos permitidos, preço/duração históricos e escapam texto',async()=>{
  await page.click('[data-view-booking="3"]');const details=await page.$eval('.agenda-dialog',e=>e.textContent);
  for(const value of ['Concluído histórico','5511999991234','Serviço','Profissional','31/10/2026 · 09:00','90 minutos','Concluído'])assert.ok(details.includes(value));
  assert.match(details,/R\$\s1\.250,50/);assert.doesNotMatch(details,/internal-field-must-not-render/);await closeDetails();
  await page.click('[data-view-booking="1"]');assert.ok((await page.$eval('.agenda-dialog',e=>e.textContent)).includes('<img src=x'));assert.equal(await page.$('.agenda-dialog img'),null);assert.equal(await page.evaluate(()=>window.agendaXss),undefined);await closeDetails();
 });
 await t.test('mensagens vazias para cada filtro, profissional e calendário',async()=>{
  const saved=rows;rows=[];await open();assert.match(await page.$eval('#view',e=>e.textContent),/Nenhum agendamento nesta semana/);
  for(const [key,text]of [['hoje','Nenhum agendamento hoje'],['proximos','Nenhum próximo agendamento'],['concluidos','Nenhum atendimento concluído'],['cancelados','Nenhum agendamento cancelado'],['todos','Nenhum agendamento cadastrado']]){await filter(key);assert.ok((await page.$eval('#view',e=>e.textContent)).includes(text));}
  await page.select('#agendaProfessional','3');assert.match(await page.$eval('#view',e=>e.textContent),/Nenhum agendamento para este profissional no filtro/);
  await page.click('#agendaMode');assert.match(await page.$eval('#view',e=>e.textContent),/Nenhum agendamento para este profissional nesta semana/);
  rows=saved;await page.select('#agendaProfessional','');await open();
 });
 await t.test('horários: carregamento, sucesso e salvar somente com seleção válida',async()=>{
  await newForm();await slotsDone();assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/Horários atualizados/);
  assert.equal(await page.$eval('#editor [type=submit]',e=>e.disabled),true);
  await page.select('[name=hora]','13:00');assert.equal(await page.$eval('#editor [type=submit]',e=>e.disabled),false);await page.click('#cancel');
 });
 await t.test('horários: erro e retry recuperam o formulário sem Consultando permanente',async()=>{
  slotMode='error';await newForm();await slotsDone();assert.ok(await page.$('#retryAgendaSlots:not([hidden])'));assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/Falha temporária/);
  assert.doesNotMatch(await page.$eval('[name=hora]',e=>e.textContent),/Consultando/);assert.equal(await page.$eval('#editor [type=submit]',e=>e.disabled),true);
  slotMode='ok';await page.click('#retryAgendaSlots');await slotsDone();assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/Horários atualizados/);await page.click('#cancel');
 });
 await t.test('horários: timeout sai do loading, permite retry e mantém regras de disponibilidade',async()=>{
  slotMode='hang';await newForm();await page.waitForFunction(()=>document.querySelector('#retryAgendaSlots').hidden===false);
  assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/demorou para responder/);assert.doesNotMatch(await page.$eval('[name=hora]',e=>e.textContent),/Consultando/);
  slotMode='ok';await page.click('#retryAgendaSlots');await slotsDone();assert.deepEqual(await page.$$eval('[name=hora] option',els=>els.map(e=>e.value)),['','09:00','13:00','15:00']);await page.click('#cancel');
 });
 await t.test('horários: contrato inválido e resposta vazia têm recuperação e mensagem clara',async()=>{
  slotMode='malformed';await newForm();await slotsDone();assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/Não foi possível consultar/);assert.ok(await page.$('#retryAgendaSlots:not([hidden])'));slotMode='ok';await page.click('#cancel');
  await page.setRequestInterception(false);
  const intercept=async request=>{if(request.url().includes('/api/studiofy/horarios'))return request.respond({status:200,contentType:'application/json',body:'[]'});request.continue();};
  page.removeAllListeners('request');await page.setRequestInterception(true);page.on('request',intercept);
  await newForm();await slotsDone();assert.match(await page.$eval('#agendaSlotsStatus',e=>e.textContent),/Nenhum horário disponível/);assert.equal(await page.$eval('#editor [type=submit]',e=>e.disabled),true);await page.click('#cancel');
  page.removeAllListeners('request');page.on('request',r=>r.url().startsWith(base)?r.continue():r.respond({status:200,contentType:'application/json',body:'{}'}));
 });
 await t.test('horários: mudanças rápidas enfileiram a seleção mais recente e não duplicam consultas',async()=>{
  const before=slotCalls;slotMode='delay';await newForm();await page.waitForFunction(()=>document.querySelector('[name=hora]').getAttribute('aria-busy')==='true');
  await page.$eval('[name=data]',e=>{e.value='2026-11-01';e.dispatchEvent(new Event('change'));e.value='2026-11-02';e.dispatchEvent(new Event('change'));e.dispatchEvent(new Event('change'));});
  assert.equal(slotCalls,before+1);slotMode='ok';for(const release of pending)release();await slotsDone();
  assert.equal(slotCalls,before+2);assert.equal(slotDates.at(-1),'2026-11-02');assert.equal(maxSlots,1);await page.click('#cancel');
 });
 await t.test('horários: sair e reabrir o formulário não inicia consultas paralelas nem aplica resposta antiga',async()=>{
  const before=slotCalls;slotMode='delay';await newForm();await page.waitForFunction(()=>document.querySelector('[name=hora]').getAttribute('aria-busy')==='true');
  await page.click('#cancel');await newForm();await page.$eval('[name=data]',e=>{e.value='2026-11-03';e.dispatchEvent(new Event('change'));});
  assert.equal(slotCalls,before+1);slotMode='ok';for(const release of pending)release();await slotsDone();
  assert.equal(slotCalls,before+2);assert.equal(slotDates.at(-1),'2026-11-03');assert.equal(maxSlots,1);await page.click('#cancel');
 });
 await t.test('ação irreversível exige confirmação; rejeitar não envia requisição',async()=>{
  await filter('todos');const before=mutationCalls;page.once('dialog',dialog=>{assert.match(dialog.message(),/estado será final/);dialog.dismiss();});
  await page.select('[data-status="2"]','cancelado');assert.equal(mutationCalls,before);assert.equal(await page.$eval('[data-status="2"]',e=>e.value),'');
 });
 await t.test('concluir, cancelar e falta dão feedback e impedem clique/requisição duplicada',async()=>{
  for(const status of ['concluido','cancelado','falta']){
   reset();await open();await filter('todos');mutationMode='delay';page.once('dialog',dialog=>dialog.accept());await page.select('[data-status="2"]',status);
   await page.waitForFunction(()=>document.querySelector('[data-status="2"]').disabled);
   await page.$eval('[data-status="2"]',(e,status)=>{e.value=status;e.dispatchEvent(new Event('change'));},status);
   await page.$eval('[data-status="1"]',e=>{e.value='cancelado';e.dispatchEvent(new Event('change'));});
   assert.equal(mutationCalls,1);for(const release of pending)release();
   await page.waitForFunction(status=>document.querySelector('[data-agenda-booking="2"] .status-'+status),{},status);
   assert.match(await page.$eval('#message',e=>e.textContent),status==='concluido'?/Atendimento concluído/:status==='cancelado'?/Agendamento cancelado/:/Falta registrada/);
   assert.equal(await page.$('[data-status="2"]'),null);
  }
 });
 await t.test('erro de ação preserva dados e reabilita controles para atualizar/tentar novamente',async()=>{
  reset();await open();await filter('todos');mutationMode='error';page.once('dialog',dialog=>dialog.accept());await page.select('[data-status="2"]','concluido');
  await page.waitForFunction(()=>document.querySelector('#message').classList.contains('error'));assert.match(await page.$eval('#message',e=>e.textContent),/estado do agendamento mudou/);
  assert.equal(await page.$eval('[data-status="2"]',e=>e.disabled),false);assert.ok(await page.$('[data-agenda-booking="2"] .status-confirmado'));
 });
 await t.test('remarcação exige confirmação, salva uma vez e apresenta feedback',async()=>{
  reset();await open();await filter('todos');await page.click('[data-reschedule="1"]');await slotsDone();await page.select('[name=hora]','15:00');
  page.once('dialog',dialog=>dialog.dismiss());await page.click('#editor [type=submit]');assert.equal(mutationCalls,0);
  mutationMode='delay';page.once('dialog',dialog=>dialog.accept());await page.click('#editor [type=submit]');
  await page.$eval('#editor',e=>e.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(mutationCalls,1);
  assert.equal(mutationBodies[0].hora,'15:00');for(const release of pending)release();await page.waitForFunction(()=>document.querySelector('#message').textContent==='Agendamento remarcado.');
 });
 for(const width of [1440,390,320])await t.test(`responsividade ${width}px: filtros, calendário, cards, detalhes e formulário com textos longos`,async()=>{
  reset();await page.setViewport({width,height:900});await open();await filter('todos');
  const fits=()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);assert.ok(await fits());
  await page.screenshot({path:path.join(screenshots,`lista-${width}.png`),fullPage:true});
  await page.click('[data-view-booking="1"]');assert.ok(await fits());assert.ok(await page.$eval('.agenda-dialog',e=>e.scrollWidth<=e.clientWidth));
  assert.equal(await page.$eval('.agenda-dialog',e=>e.scrollTop),0);assert.ok(await page.$eval('#bookingDetailsTitle',e=>e.getBoundingClientRect().top>=0));
  await page.screenshot({path:path.join(screenshots,`detalhes-${width}.png`)});
  await page.$eval('.agenda-dialog',e=>e.scrollTop=e.scrollHeight);await closeDetails();await page.click('#agendaMode');assert.ok(await fits());
  assert.ok(await page.$eval('.calendar-scroll',e=>e.scrollWidth>e.clientWidth));
  assert.ok(await page.$eval('.calendar-day',e=>e.getBoundingClientRect().height<140),'Nomes longos não devem esconder os horários sob um cabeçalho excessivo');
  await page.screenshot({path:path.join(screenshots,`calendario-${width}.png`)});
  await page.$eval('.calendar-scroll',e=>e.scrollLeft=e.scrollWidth);assert.ok((await page.$eval('.calendar-scroll',e=>e.scrollLeft))>0);
  await page.click('[data-calendar-booking="6"]');assert.match(await page.$eval('.agenda-dialog',e=>e.textContent),/01\/11\/2026/);await closeDetails();
  await page.click('#newBooking');await slotsDone();assert.ok(await fits());assert.ok(await page.$eval('.agenda-booking-form',e=>e.scrollWidth<=e.clientWidth));await page.screenshot({path:path.join(screenshots,`formulario-${width}.png`),fullPage:true});await page.click('#cancel');
 });
 assert.deepEqual(errors,[]);
});
