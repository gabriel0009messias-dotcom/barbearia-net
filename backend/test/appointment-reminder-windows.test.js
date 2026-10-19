const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process'),path=require('node:path');
const {setReminderClock}=require('./helpers/reminderClock');
const {createReminderWorker}=require('../services/reminders');
const {createEvolutionDelivery}=require('../services/evolutionDelivery');
test('Appointment reminders: lifetime windows, revisions, durable frontier and recovery',{timeout:180000},async t=>{
 const env=require('./helpers/postgres').testEnvironment(),db=require('../database');await db.ready;
 await require('./helpers/appointmentTransportPolicy').enableAppointmentTransport(db);
 const q=(sql,args=[])=>db.pool.query(sql,args),accepted=()=>({key:{id:randomUUID()},status:'PENDING'});
 const at=time=>'2030-01-02T'+time+':00-03:00';
 let tenant,appointment,professional,service,calls;
 const rows=()=>db.allAsync('SELECT * FROM appointment_reminders WHERE appointment_id=$1 ORDER BY id',[appointment]);
 const current=kind=>db.getAsync('SELECT * FROM appointment_reminders WHERE appointment_id=$1 AND reminder_kind=$2 ORDER BY id DESC LIMIT 1',[appointment,kind]);
 const now=async time=>setReminderClock(db,time.includes('T')?time:at(time));
 const drain=async(send=async(...args)=>{calls.push(args);return accepted();})=>createReminderWorker(db,send).drain();
 const edit=async(sql,args=[])=>db.runAsync('UPDATE agendamentos SET '+sql+' WHERE id=$1',[appointment,...args]);
 async function fixture(){
  calls=[];
  const a=await db.runAsync(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento)
   VALUES('Studio Seguro','Responsável','11999990000','mercado_pago',5,'',$1,'ativo','2099-01-01')`,['reminder-'+randomUUID()]);tenant=a.lastID;
  professional=(await db.runAsync("INSERT INTO profissionais(assinatura_id,nome) VALUES($1,'Ana')",[tenant])).lastID;
  service=(await db.runAsync("INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES($1,'Massagem',30)",[tenant])).lastID;
  appointment=(await db.runAsync(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,profissional_id,studio_service_id,status)
   VALUES($1,'Cliente Teste','5511999990001','Massagem',30,'2030-01-02','14:00',$2,$3,'confirmado')`,[tenant,professional,service])).lastID;
  await now('13:45');
 }
 t.beforeEach(fixture);
 t.afterEach(async()=>{await q('UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL');await db.transaction(async c=>{await c.runAsync('DELETE FROM agendamentos WHERE assinatura_id=$1',[tenant]);await c.runAsync('DELETE FROM assinaturas WHERE id=$1',[tenant]);});});
 t.after(async()=>{await db.close();await env.cleanup();});
 await t.test('14:00 -> 13:45 and 13:55, before/exact/after windows, independent and at most once',async()=>{
  const r=await rows();assert.equal(r.length,2);assert.deepEqual(r.map(x=>x.reminder_kind),['reminder_15m','reminder_5m']);
  assert.equal(+r[0].due_at,+new Date(at('13:45')));assert.equal(+r[1].due_at,+new Date(at('13:55')));
  await now('13:44');await drain();assert.equal(calls.length,0);
  await now('13:45');await drain();await drain();assert.equal(calls.length,1);
  await now('13:54');await drain();assert.equal(calls.length,1);
  await now('13:55');await drain();await drain();assert.equal(calls.length,2);
  assert.ok(calls[0][2].includes('Massagem'));assert.ok(calls[0][2].includes('Ana'));assert.ok(calls[0][2].includes('02/01/2030 às 14:00'));assert.ok(calls[0][2].includes('Studio Seguro'));
  assert.ok((await rows()).every(x=>x.status==='sent'));
 });
 await t.test('short tolerance, no false countdown and long outage does not batch both',async()=>{
  await now('2030-01-02T13:45:30-03:00');await drain();assert.equal(calls.length,1);assert.doesNotMatch(calls[0][2],/em (15|5) minutos/);
  await now('13:57');await drain();assert.equal(calls.length,1);assert.equal((await current('reminder_5m')).status,'expired');
 });
 await t.test('both expired after long outage; no send at appointment start',async()=>{await now('14:00');await drain();assert.equal(calls.length,0);assert.ok((await rows()).every(x=>x.status==='expired'));});
 await t.test('tolerance expires at exactly sixty seconds and never catches up 15m at 5m',async()=>{
  await now('13:46');await drain();assert.equal(calls.length,0);
  assert.equal((await current('reminder_15m')).status,'expired');
  await now('13:55');await drain();assert.equal(calls.length,1);
  assert.equal((await current('reminder_5m')).status,'sent');
 });
 await t.test('no-op appointment updates preserve revision and reminder rows',async()=>{
  const before=await rows();await edit('telefone=telefone');
  assert.deepEqual(await rows(),before);
 });
 await t.test('operationally blocked tenant never reaches transport',async()=>{
  await db.runAsync('UPDATE assinaturas SET bloqueado=1 WHERE id=$1',[tenant]);
  await drain();assert.equal(calls.length,0);
  assert.equal((await current('reminder_15m')).status,'cancelled');
 });
 for(const afterFirst of [false,true])await t.test('cancellation '+(afterFirst?'between windows':'before first window'),async()=>{
  if(afterFirst)await drain();await edit("status='cancelado'");await now('13:55');await drain();assert.equal(calls.length,afterFirst?1:0);
 });
 await t.test('reschedule before both and A -> B -> A produces three distinct revisions',async()=>{
  await edit("hora='16:00'");await edit("hora='14:00'");
  const all=await rows();assert.equal(new Set(all.map(r=>r.schedule_revision)).size,3);assert.equal(all.filter(r=>r.status==='pending').length,2);
  await drain();assert.equal(calls.length,1);assert.equal((await current('reminder_15m')).status,'sent');
 });
 await t.test('reschedule after 15m never renews lifetime 15m, recalculates 5m',async()=>{
  await drain();const sent=await current('reminder_15m');await edit("hora='16:00'");await now('15:45');await drain();assert.equal(calls.length,1);
  await now('15:55');await drain();assert.equal(calls.length,2);assert.deepEqual(await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[sent.id]),sent);
  assert.match(calls[1][2],/16:00/);
 });
 await t.test('after both kinds are sent, rescheduling never creates another send budget',async()=>{
  await drain();await now('13:55');await drain();const sent=await rows();
  await edit("hora='16:00'");await now('15:45');await drain();await now('15:55');await drain();
  assert.equal(calls.length,2);assert.deepEqual(await rows(),sent);
 });
 for(const [label,sql,pattern] of [
  ['phone',"telefone='5511988880002'",null],['service',"servico_nome='Corte'",/Corte/],
  ['professional',"profissional_id=NULL",null],['name',"nome_cliente='Outro Cliente'",/Outro Cliente/],
 ])await t.test(label+' change invalidates pending snapshot without renewing sent types',async()=>{
  await edit(sql);await drain();assert.equal(calls.length,1);if(pattern)assert.match(calls[0][2],pattern);
  if(label==='phone')assert.equal(calls[0][1],'5511988880002');if(label==='professional')assert.doesNotMatch(calls[0][2],/Profissional:/);
 });
 await t.test('professional reassignment uses new official tenant professional',async()=>{
  const p=await db.runAsync("INSERT INTO profissionais(assinatura_id,nome) VALUES($1,'Bia')",[tenant]);await edit('profissional_id=$2',[p.lastID]);await drain();assert.match(calls[0][2],/Bia/);
 });
 await t.test('renamed establishment and professional refresh pending official snapshots',async()=>{
  await db.runAsync("UPDATE assinaturas SET barbearia_nome='Studio Atual' WHERE id=$1",[tenant]);
  await db.runAsync("UPDATE profissionais SET nome='Ana Atual' WHERE id=$1 AND assinatura_id=$2",[professional,tenant]);
  await drain();assert.equal(calls.length,1);assert.match(calls[0][2],/Studio Atual/);assert.match(calls[0][2],/Ana Atual/);
 });
 await t.test('invalid telephone never reaches delivery',async()=>{await edit("telefone='123'");await drain();assert.equal(calls.length,0);assert.equal((await current('reminder_15m')).status,'cancelled');});
 for(const status of ['concluido','falta'])await t.test(status+' blocks both windows',async()=>{
  await edit("data='2020-01-02'");await edit('status=$2',[status]);await now('2020-01-02T13:45:00-03:00');await drain();assert.equal(calls.length,0);
 });
 await t.test('two workers claim once and HTTP holds no appointment/global lock',async()=>{
  const send=async()=>{calls.push(1);const c=await db.pool.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM agendamentos WHERE id=$1 FOR UPDATE NOWAIT',[appointment]);await c.query('ROLLBACK');}finally{c.release();}return accepted();};
  await Promise.all([drain(send),drain(send)]);assert.equal(calls.length,1);
 });
 async function child(mode){
  const c=spawn(process.execPath,[path.join(__dirname,'helpers/appointment-reminder-process.js')],{env:{...process.env,REMINDER_TEST_MODE:mode},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let error='';c.stderr.on('data',b=>{error+=b;});const messages=[];c.on('message',m=>messages.push(m));
  const exited=new Promise(resolve=>c.once('exit',code=>resolve({code,messages,error})));
  const wait=async expected=>{if(messages.includes(expected))return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child barrier timeout: '+error)),10000);c.on('message',m=>{if(m===expected){clearTimeout(timer);resolve();}});c.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited before barrier: '+error));});});};
  return {c,exited,wait};
 }
 await t.test('two real processes converge to one send; restart cannot resend',async()=>{
  const a=await child('drain'),b=await child('drain');const result=await Promise.all([a.exited,b.exited]);assert.ok(result.every(r=>r.code===0),JSON.stringify(result));assert.equal(result.flatMap(r=>r.messages).filter(m=>m==='transport').length,1);await drain();assert.equal(calls.length,0);
 });
 for(const mode of ['before_claim','claim','after_frontier','crash_transport'])await t.test('process crash '+mode+' preserves safe restart',async()=>{
  const c=await child(mode);try{await c.wait(mode==='before_claim'?'ready':mode==='claim'?'claimed':mode==='after_frontier'?'frontier':'transport');}finally{c.c.kill();await c.exited;}
  await db.runAsync("UPDATE appointment_reminders SET claimed_at=clock_timestamp()-interval '10 years' WHERE status='sending'");
  const uncertain=['after_frontier','crash_transport'].includes(mode);
  await drain();assert.equal(calls.length,uncertain?0:1);
  assert.equal((await current('reminder_15m')).status,uncertain?'uncertain':'sent');
 });
 await t.test('uncertain is never recycled across restart, edits, or cancellation',async()=>{
  await drain(async()=>{calls.push(1);throw Error('Synthetic ambiguous acceptance');});const r=await current('reminder_15m');assert.equal(r.status,'uncertain');
  await edit("hora='16:00'");await now('15:45');await drain();assert.equal(calls.length,1);
  await edit("status='cancelado'");assert.deepEqual(await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[r.id]),r);
 });
 await t.test('missing ownership and changed ownership prevent transport',async()=>{
  await db.runAsync('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1',[tenant]);await drain();assert.equal(calls.length,0);assert.equal((await current('reminder_15m')).status,'failed');
 });
 await t.test('changed instance is not silently substituted for captured owner',async()=>{
  await db.runAsync('UPDATE assinaturas SET whatsapp_session=$2 WHERE id=$1',[tenant,'changed-'+randomUUID()]);
  await drain();assert.equal(calls.length,0);assert.equal((await current('reminder_15m')).status,'failed');
 });
 for(const field of ["telefone='5511988880002'","hora='16:00'","servico_nome='Outro'","profissional_id=NULL"])await t.test('frontier rejects concurrent context edit: '+field,async()=>{
  const r=await current('reminder_15m'),claim=randomUUID();await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,r.id]);
  await createEvolutionDelivery(db).dispatch('appointment_reminders',{...r,claim_token:claim,instance:r.snapshot.instance,phone:r.destination,response:'Synthetic'},()=>assert.fail('Stale payload must never be sent'),{validate:async()=>{await edit(field);return true;}});
  assert.equal((await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[r.id])).dispatch_started_at,null);
 });
 await t.test('frontier rejects cancellation after callback validation',async()=>{
  const r=await current('reminder_15m'),claim=randomUUID();await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,r.id]);
  await createEvolutionDelivery(db).dispatch('appointment_reminders',{...r,claim_token:claim,instance:r.snapshot.instance,phone:r.destination,response:'Synthetic'},()=>assert.fail('Transport must be fenced'),{validate:async()=>{await edit("status='cancelado'");return true;}});
  assert.equal((await current('reminder_15m')).dispatch_started_at,null);
 });
 await t.test('frontier NOWAIT avoids deadlock with concurrent appointment writer',async()=>{
  const c=await db.pool.connect();await c.query('BEGIN');await c.query('SELECT id FROM agendamentos WHERE id=$1 FOR UPDATE',[appointment]);
  try{await drain();assert.equal(calls.length,0);}finally{await c.query('ROLLBACK');c.release();}await drain();assert.equal(calls.length,1);
 });
 await t.test('contention at the actual durable frontier safely revokes an unstarted claim',async()=>{
  const r=await current('reminder_15m'),claim=randomUUID(),c=await db.pool.connect();
  await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,r.id]);
  await c.query('BEGIN');await c.query('SELECT id FROM agendamentos WHERE id=$1 FOR UPDATE',[appointment]);
  try{await createEvolutionDelivery(db).dispatch('appointment_reminders',{...r,claim_token:claim,instance:r.snapshot.instance,phone:r.destination,response:'Synthetic'},()=>assert.fail('Contended frontier must not send'),{validate:async()=>true});}
  finally{await c.query('ROLLBACK');c.release();}
  const stored=await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[r.id]);assert.equal(stored.status,'pending');assert.equal(stored.dispatch_started_at,null);assert.notEqual(stored.claim_token,claim);
 });
 await t.test('frontier rejects a forged start even if snapshot and revision match',async()=>{
  const r=await current('reminder_15m');await db.runAsync('DELETE FROM appointment_reminders WHERE id=$1',[r.id]);
  const inserted=await db.getAsync(`INSERT INTO appointment_reminders(assinatura_id,appointment_id,reminder_kind,schedule_revision,starts_at,due_at,expires_at,snapshot,destination)
   VALUES($1,$2,'reminder_15m',$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[tenant,appointment,r.schedule_revision,new Date(+r.starts_at+3600000),new Date(+r.due_at+3600000),new Date(+r.expires_at+3600000),JSON.stringify(r.snapshot),r.destination]);
  await now('14:45');const claim=randomUUID();await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1 WHERE id=$2",[claim,inserted.id]);
  await createEvolutionDelivery(db).dispatch('appointment_reminders',{...inserted,claim_token:claim,instance:r.snapshot.instance,phone:r.destination,response:'Synthetic'},()=>assert.fail('Forged start must not send'),{validate:async()=>true});
  assert.equal((await db.getAsync('SELECT * FROM appointment_reminders WHERE id=$1',[inserted.id])).dispatch_started_at,null);
 });
 await t.test('SQL and JS destination decisions agree; timezone crosses previous day',async()=>{
  const normalize=require('../services/whatsapp/phone').normalizeBrazilianDestination;
  for(const phone of ['11999990001','5511999990001','+55 (11) 99999-0001','123','+111999990001'])assert.equal((await db.getAsync('SELECT studiofy_reminder_destination($1) AS phone',[phone])).phone,normalize(phone));
  await edit("hora='00:05'");const r=await current('reminder_15m');assert.equal(r.due_at.toISOString(),'2030-01-02T02:50:00.000Z');
  await now('2030-01-01T23:50:00-03:00');await drain();assert.equal(calls.length,1);
 });
 await t.test('tenant isolation and immutable reminder identity',async()=>{
  const r=await current('reminder_15m');await assert.rejects(db.runAsync('UPDATE appointment_reminders SET assinatura_id=$1 WHERE id=$2',[tenant+1,r.id]),e=>e.code==='23514');
  await assert.rejects(db.runAsync("UPDATE appointment_reminders SET snapshot='{}' WHERE id=$1",[r.id]),e=>e.code==='23514');
  await drain();await assert.rejects(db.runAsync("UPDATE appointment_reminders SET status='pending' WHERE id=$1",[r.id]),e=>e.code==='23514');
 });
 await t.test('database timezone cannot move the Sao Paulo reminder instants',async()=>{
  const c=await db.pool.connect();try{
   await c.query('BEGIN');await c.query("SET LOCAL TIME ZONE 'Pacific/Auckland'");await c.query("UPDATE agendamentos SET hora='00:05' WHERE id=$1",[appointment]);await c.query('COMMIT');
  }finally{c.release();}
  assert.equal((await current('reminder_15m')).due_at.toISOString(),'2030-01-02T02:50:00.000Z');
 });
 await t.test('Sao Paulo historical daylight saving uses timezone rules rather than fixed minus three',async()=>{
  await edit("data='2018-01-02',hora='00:05'");
  const r=await current('reminder_15m');
  assert.equal(r.starts_at.toISOString(),'2018-01-02T02:05:00.000Z');
  assert.equal(r.due_at.toISOString(),'2018-01-02T01:50:00.000Z');
  await now('2018-01-02T01:50:00Z');await drain();assert.equal(calls.length,1);
 });
});
