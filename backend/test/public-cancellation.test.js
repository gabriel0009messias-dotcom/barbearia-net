const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
test('Cancelamento público: capacidades individuais, regras e lembretes',async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 process.env.MERCADO_PAGO_ACCESS_TOKEN='';process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';
 const db=require('../database');await db.ready;
 const app=express();app.use(express.json());app.use('/api',require('../routes'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await env.cleanup();});
 const req=async(path,body,token,method=body?'POST':'GET')=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/studiofy${path}`,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,data:await r.json(),cache:r.headers.get('cache-control')};
 };
 const raw=async(path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
 const owners=[];
 for(let n=0;n<2;n++){
  const email=`cancel-${n}@example.test`,signup=await raw('/publico/assinaturas',{barbeariaNome:'Studio '+n,responsavelNome:'Pessoa',telefone:'1199999555'+n,email,senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,servicos:[{nome:'Cuidado',preco:30}]});
  const id=signup.assinatura.id;
  await db.runAsync("UPDATE assinaturas SET acesso_manual_ate='2099-01-01',weekly_hours=$1,whatsapp_session=$2 WHERE id=$3",[JSON.stringify(Array.from({length:7},()=>[['08:00','18:00']])),'test-instance-'+n,id]);
  const login=await raw('/barbeiro/login',{identificador:email,senha:'test-password'});
  const panel=(await req('/painel',null,login.token)).data;
  owners.push({id,token:login.token,slug:panel.pagina.slug,service:panel.servicos[0].id,professional:panel.profissionais[0].id});
 }
 const [a,b]=owners,date=new Date(Date.now()+2*86400000).toISOString().slice(0,10);
 const body=(owner,hour,name='Cliente')=>({nome_cliente:name,telefone:'11999990000',servico_id:owner.service,profissional_id:owner.professional,data:date,hora:hour});
 const book=async(owner,hour,name)=>{const r=await req('/public/'+owner.slug+'/agendamentos',body(owner,hour,name));assert.equal(r.status,201);return r.data;};
 const internalId=async token=>(await db.getAsync('SELECT appointment_id FROM public_booking_access WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')])).appointment_id;
 let first,firstId;
 await t.test('token aleatório individual, sem ID sequencial ou hash na resposta',async()=>{
  first=await book(a,'08:00','Cliente A');firstId=await internalId(first.token);
  assert.match(first.token,/^[a-f0-9]{64}$/);assert.equal(first.id,undefined);assert.equal(first.agendamento.id,undefined);
  const stored=await db.getAsync('SELECT * FROM public_booking_access WHERE appointment_id=$1',[firstId]);assert.notEqual(stored.token_hash,first.token);
  const r=await req('/public/reservas/consultar',{token:first.token});assert.equal(r.status,200);assert.equal(r.cache,'no-store');assert.equal(r.data.nome_cliente,'Cliente A');assert.equal(r.data.token_hash,undefined);assert.equal(r.data.telefone,undefined);
 });
 await t.test('confirmação obrigatória; consulta e Voltar não cancelam',async()=>{
  assert.equal((await req('/public/reservas/cancelar',{token:first.token})).status,400);
  assert.equal((await req('/public/reservas/cancelar',{token:first.token,confirmar:'true'})).status,400);
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[firstId])).status,'confirmado');
 });
 await t.test('cancelamento normal preserva registro, libera horário e cancela lembrete',async()=>{
  const cancelled=await req('/public/reservas/cancelar',{token:first.token,confirmar:true});assert.equal(cancelled.status,200);assert.equal(cancelled.data.status,'cancelado');
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[firstId])).status,'cancelado');
  assert.equal((await db.getAsync('SELECT status FROM appointment_reminders WHERE appointment_id=$1',[firstId])).status,'cancelled');
  const times=(await req('/public/'+a.slug+'/horarios?'+new URLSearchParams({data:date,servico_id:a.service,profissional_id:a.professional}))).data;assert.ok(times.includes('08:00'));
  assert.equal((await req('/painel',null,a.token)).data.agendamentos.find(x=>x.id===firstId).status,'cancelado');
 });
 await t.test('lembrete cancelado não é enviado pelo worker, mesmo após reiniciar worker',async()=>{
  let sends=0;const {createReminderWorker}=require('../services/reminders');
  for(let n=0;n<2;n++)await createReminderWorker(db,async()=>sends++,()=>new Date(date+'T07:40:00-03:00')).drain();
  assert.equal(sends,0);
 });
 await t.test('segunda tentativa de cancelamento é recusada',async()=>{
  assert.equal((await req('/public/reservas/cancelar',{token:first.token,confirmar:true})).status,409);
 });
 await t.test('token inválido, ausente e ID conhecido não dão acesso',async()=>{
  for(const token of [undefined,String(firstId),'invalid',crypto.randomBytes(32).toString('hex')]){
   assert.equal((await req('/public/reservas/consultar',{token})).status,404);
   assert.equal((await req('/public/reservas/cancelar',{token,confirmar:true})).status,404);
  }
 });
 await t.test('mesmo telefone não revela outras reservas; IDs fornecidos não escolhem outra pessoa',async()=>{
  const own=await book(a,'09:00','Pessoa A'),other=await book(a,'10:00','Pessoa B'),tenantB=await book(b,'09:00','Pessoa C');
  assert.notEqual(own.token,other.token);assert.notEqual(own.token,tenantB.token);
  const otherId=await internalId(other.token);
  const r=await req('/public/reservas/consultar',{token:own.token,id:otherId,telefone:'11999990000'});assert.equal(r.data.nome_cliente,'Pessoa A');assert.ok(!JSON.stringify(r.data).includes('Pessoa B'));
  assert.equal((await req('/public/reservas/cancelar',{token:own.token,id:otherId,confirmar:true})).status,200);
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[otherId])).status,'confirmado');
  assert.equal((await req('/public/reservas/consultar',{token:tenantB.token})).data.estabelecimento,'Studio 1');
 });
 await t.test('concluído e falta não podem ser cancelados',async()=>{
  for(const [hour,status] of [['11:00','concluido'],['12:00','falta']]){
   const booking=await book(a,hour),id=await internalId(booking.token);
   await db.runAsync('UPDATE agendamentos SET status=$1 WHERE id=$2',[status,id]);
   assert.equal((await req('/public/reservas/consultar',{token:booking.token})).data.cancelavel,false);
   assert.equal((await req('/public/reservas/cancelar',{token:booking.token,confirmar:true})).status,409);
  }
 });
 await t.test('antecedência configurável pelo dono e aplicada a reservas existentes',async()=>{
  const booking=await book(a,'13:00');
  assert.equal((await req('/politica-cancelamento',{antecedencia_minutos:4320},null,'PUT')).status,401);
  for(const value of [-1,1.5,'30',129601])assert.equal((await req('/politica-cancelamento',{antecedencia_minutos:value},a.token,'PUT')).status,400);
  assert.equal((await req('/politica-cancelamento',{antecedencia_minutos:4320,assinatura_id:b.id},a.token,'PUT')).status,200);
  assert.equal((await db.getAsync('SELECT cancellation_notice_minutes FROM assinaturas WHERE id=$1',[b.id])).cancellation_notice_minutes,0);
  assert.equal((await req('/public/reservas/consultar',{token:booking.token})).data.cancelavel,false);
  assert.equal((await req('/public/reservas/cancelar',{token:booking.token,confirmar:true})).status,409);
  assert.equal((await req('/politica-cancelamento',{antecedencia_minutos:0},a.token,'PUT')).status,200);
  assert.equal((await req('/public/reservas/cancelar',{token:booking.token,confirmar:true})).status,200);
 });
 await t.test('limite exato de antecedência e início do atendimento',async()=>{
  const {createPublicBookings}=require('../services/publicBookings');
  const booking=await book(a,'14:00'),start=new Date(date+'T14:00:00-03:00').getTime();
  await req('/politica-cancelamento',{antecedencia_minutos:60},a.token,'PUT');
  assert.equal((await createPublicBookings(db,()=>new Date(start-3600000)).get(booking.token)).cancelavel,true);
  await assert.rejects(db.transaction(c=>createPublicBookings(c,()=>new Date(start-3599999)).cancel(booking.token)),e=>e.statusCode===409);
  await req('/politica-cancelamento',{antecedencia_minutos:0},a.token,'PUT');
  await assert.rejects(db.transaction(c=>createPublicBookings(c,()=>new Date(start)).cancel(booking.token)),e=>e.statusCode===409);
 });
 await t.test('duas confirmações concorrentes só cancelam uma vez',async()=>{
  const booking=await book(a,'15:00');
  const results=await Promise.all([1,2].map(()=>req('/public/reservas/cancelar',{token:booking.token,confirmar:true})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 });
});
