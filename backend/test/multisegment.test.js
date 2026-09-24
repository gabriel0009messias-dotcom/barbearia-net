const {test}=require('node:test');
const assert=require('node:assert/strict');
const {profileInput,publicProfile}=require('../services/establishment');
const {serviceInput}=require('../services/studiofy');
const catalog={getAsync:async(_sql,[code])=>['barbershop','nails','eyebrows','massage','custom'].includes(code)?{code}:null};

for(const [businessType,nome,preco,duracao,categoria] of [
 ['barbershop','Corte masculino',30,30,'Cabelo'],['nails','Alongamento de unhas',120,120,'Unhas'],
 ['eyebrows','Design de sobrancelha',35,30,'Sobrancelhas'],['massage','Massagem relaxante',100,60,'Bem-estar'],
])test(`segmento ${businessType}: perfil e serviço livre`,async()=>{
 const p=await profileInput(catalog,{businessType,city:'Salvador',state:'ba',address:'Rua A',instagram:'@studio.bella'});
 assert.equal(p.state,'BA');assert.equal(p.instagram,'studio.bella');assert.equal(p.businessType,businessType);
 const s=await serviceInput({nome,preco,duracao,categoria,descricao:'Atendimento personalizado',ativo:true});
 assert.equal(s.nome,nome);assert.equal(s.duracao,duracao);assert.equal(s.categoria,categoria);
 // Segment is metadata: any type may offer any service.
 assert.equal((await serviceInput({nome:'Serviço livre',preco:0,duracao:45})).nome,'Serviço livre');
});
test('tipos configuráveis aceitam entrada do catálogo sem enum fixo na aplicação',async()=>{
 assert.equal((await profileInput(catalog,{businessType:'custom'})).businessType,'custom');
 await assert.rejects(profileInput(catalog,{businessType:'unknown'}),e=>e.statusCode===400);
});
test('perfil valida UF, links e tipos; campos omitidos preservam compatibilidade',async()=>{
 for(const value of [{state:'XX'},{instagram:'javascript:alert(1)'},{city:{}},{address:'a'.repeat(251)}])await assert.rejects(profileInput(catalog,value),e=>e.statusCode===400);
 assert.deepEqual(await profileInput(catalog,{}),{});
 assert.equal((await serviceInput({nome:'Legado',preco:30,duracao:30})).categoria,undefined);
 await assert.rejects(serviceInput({nome:'Teste',preco:10,duracao:30,categoria:'x'.repeat(101)}),e=>e.statusCode===400);
 const output=publicProfile({senha_hash:'secret',email:'private@example.test',localizacao_cidade:'Recife'});
 assert.equal(output.city,'Recife');assert.equal(output.businessType,'other');assert.ok(!('senha_hash' in output));assert.ok(!('email' in output));
});

test('PostgreSQL: quatro segmentos, isolamento, conflito, cancelamento e lembrete', {skip:!process.env.TEST_DATABASE_URL?'TEST_DATABASE_URL não configurada':false},async t=>{
 const environment=require('./helpers/postgres').testEnvironment();
 process.env.MERCADO_PAGO_ACCESS_TOKEN='';process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';
 const db=require('../database');await db.ready;
 const express=require('express'),app=express();app.use(express.json({limit:'6mb'}));app.use('/api',require('../routes'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await db.close();await environment.cleanup();});
 const request=async(path,method='GET',body,token)=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{'Content-Type':'application/json',...(token?{'x-barbeiro-token':token}:{})},body:body?JSON.stringify(body):undefined});
  return {status:r.status,body:await r.json()};
 };
 const types=await request('/publico/business-types');assert.equal(types.status,200);assert.equal(types.body.length,11);
 const tenants=[];
 const sharp=require('sharp');const png=await sharp({create:{width:8,height:8,channels:3,background:'blue'}}).png().toBuffer();
 for(const [i,type] of ['barbershop','nails','eyebrows','massage'].entries()){
  const input={establishmentName:`Studio ${type}`,businessType:type,responsavelNome:`Pessoa ${i}`,telefone:`551199999888${i}`,email:`segment${i}@example.test`,senha:'test-password',metodoPagamento:'mercado_pago',diaVencimento:5,city:'Salvador',state:'BA',address:'Rua A',instagram:'@studio.bella',logo:'data:image/png;base64,'+png.toString('base64'),servicos:[{nome:['Corte','Manicure','Design','Massagem'][i],preco:40,duracao:45,categoria:type}]};
  const invalid=await request('/publico/assinaturas','POST',{...input,state:'XX'});assert.equal(invalid.status,400);
  const created=await request('/publico/assinaturas','POST',input);assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.assinatura.id;
  await db.runAsync("UPDATE assinaturas SET status='ativo',status_assinatura='ATIVA',bloqueado=0,proximo_vencimento='2099-12-01',data_vencimento='2099-12-01',weekly_hours=$2 WHERE id=$1",[id,JSON.stringify(Array.from({length:7},()=>[['08:00','18:00']]))]);
  const login=await request('/barbeiro/login','POST',{identificador:input.email,senha:input.senha});assert.equal(login.status,200);
  const token=login.body.token,panel=(await request('/studiofy/painel','GET',null,token)).body;
  const page=(await request('/studiofy/public/'+panel.pagina.slug)).body;
  assert.equal(page.businessType,type);assert.equal(page.city,'Salvador');assert.equal(page.instagram,'studio.bella');assert.match(page.logo,/^data:image\/webp;base64,/);
  assert.equal(page.servicos.length,1);assert.equal(page.servicos[0].categoria,type);assert.equal(page.servicos[0].duracao,45);assert.equal(page.profissionais.length,1);
  assert.equal(page.profissionais[0].nome,input.responsavelNome);assert.ok(!('email' in page));
  // Old page clients omit the new fields; saving must not erase them.
  assert.equal((await request('/studiofy/pagina','PUT',{nome:page.nome,slug:page.slug,telefone:page.telefone,descricao:'Atualizado',cor:page.cor,logo:page.logo,capa:null},token)).status,200);
  assert.equal((await request('/studiofy/public/'+page.slug)).body.businessType,type);
  tenants.push({id,token,page});
 }
 const [a,b]=tenants,service=a.page.servicos[0],professional=a.page.profissionais[0];
 assert.equal((await request('/studiofy/servicos/'+service.id,'PUT',{...service,categoria:'Outra'},b.token)).status,404);
 assert.equal((await request('/studiofy/profissionais','POST',{nome:'Pessoa',ativo:true,servicos:[service.id]},b.token)).status,400);
 assert.equal((await request('/studiofy/profissionais/'+professional.id,'PUT',{nome:'Outra',ativo:true,servicos:[]},b.token)).status,404);
 const date=new Date(Date.now()+86400000*2).toISOString().slice(0,10);
 const booking={nome_cliente:'Cliente',telefone:'11999990000',servico_id:service.id,profissional_id:professional.id,data:date,hora:'10:00'};
 const url='/studiofy/public/'+a.page.slug+'/agendamentos';
 assert.equal((await request('/studiofy/public/'+b.page.slug+'/agendamentos','POST',booking)).status,409);
 const attempts=await Promise.all([request(url,'POST',booking),request(url,'POST',booking)]);
 assert.deepEqual(attempts.map(x=>x.status).sort(),[201,409]);
 assert.equal((await request(url,'POST',{...booking,hora:'10:15'})).status,409);
 const token=attempts.find(x=>x.status===201).body.token;
 const appointment=await db.getAsync('SELECT * FROM agendamentos WHERE assinatura_id=$1',[a.id]);
 const reminder=await db.getAsync('SELECT * FROM appointment_reminders WHERE appointment_id=$1',[appointment.id]);
 assert.equal(+new Date(reminder.due_at),+new Date(date+'T09:40:00-03:00'));
 assert.equal((await request('/studiofy/public/reservas/cancelar','POST',{token,confirmar:true})).status,200);
 assert.equal((await db.getAsync('SELECT status FROM appointment_reminders WHERE appointment_id=$1',[appointment.id])).status,'cancelled');
 let sent=0;await require('../services/reminders').createReminderWorker(db,async()=>sent++,()=>new Date(date+'T09:40:00-03:00')).drain();assert.equal(sent,0);
 assert.equal((await request(url,'POST',booking)).status,201);
 await require('../services/reminders').createReminderWorker(db,async(_instance,_phone,message)=>{sent++;assert.match(message,/Corte/);assert.match(message,/20 minutos/);},()=>new Date(date+'T09:40:00-03:00')).drain();
 assert.equal(sent,1);
 await require('../services/reminders').createReminderWorker(db,async()=>sent++,()=>new Date(date+'T09:40:00-03:00')).drain();assert.equal(sent,1);
});
