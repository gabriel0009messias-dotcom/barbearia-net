const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {transitionAppointment}=require('../services/agenda');

test('legacy return suppression through 023, followed by lossless upgrade to 024',async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 Object.assign(process.env,{EVOLUTION_API_URL:'',EVOLUTION_API_KEY:'',MERCADO_PAGO_ACCESS_TOKEN:''});
 // Exercise the retired source-owned claim protocol on its actual schema, then
 // upgrade populated historical records. Outbox tests exercise 024 directly.
 const fs=require('node:fs'),path=require('node:path'),directory=path.resolve(__dirname,'../database/migrations');
 const read=fs.readdirSync;
 const discovery=t.mock.method(fs,'readdirSync',function(dir,...args){const files=read.call(this,dir,...args);return path.resolve(String(dir))===directory?files.filter(name=>name<'024_'):files;});
 const db=require('../database');try{await db.ready;}finally{discovery.mock.restore();}
 t.after(async()=>{await db.close();await env.cleanup();});
 const nativeFetch=global.fetch;
 let networkCalls=0;const logs=[];
 t.mock.method(global,'fetch',async()=>{networkCalls++;throw Error('Network forbidden');});
 for(const level of ['log','info','warn','error','debug'])t.mock.method(console,level,(...args)=>logs.push(args));
 for(const id of [6,806])await db.runAsync(`INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero)
  VALUES ($1,'Synthetic establishment','Synthetic owner','11988886060','mercado_pago',5,'11977776060')`,[id]);
 let seq=0;
 const service=async(tenant=6,name='Serviço arbitrário')=>(await db.runAsync('INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES ($1,$2,30)',[tenant,name])).lastID;
 const book=async(sid,{tenant=6,phone='5511999996060',name='Serviço histórico',future=false,status='confirmado'}={})=>(await db.runAsync(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status,studio_service_id)
  VALUES ($1,'Cliente histórico Ágata 👋',$2,$3,30,$4,'12:00',$5,$6)`,[tenant,phone,name,future?'2099-01-01':new Date(Date.UTC(2020,0,++seq)).toISOString().slice(0,10),status,sid])).lastID;
 const complete=async(id,tenant=6)=>transitionAppointment(db,tenant,id,'concluido');
 const row=async id=>db.getAsync('SELECT * FROM return_reminders WHERE appointment_id=$1',[id]);
 const group=async(c,r)=>c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)',[r.assinatura_id,r.customer_key,r.service_identity]);
 const refresh=async r=>db.transaction(async c=>{await group(c,r);return c.getAsync('SELECT studiofy_return_supersede_group($1,$2,$3) n',[r.assinatura_id,r.customer_key,r.service_identity]);},{serialize:false});
 const facts=r=>{const {status,reason_code,claim_token,lease_until,updated_at,...rest}=r;return rest;};
 const setState=async(r,status,dispatch=false)=>db.transaction(async c=>{await group(c,r);await c.runAsync(`UPDATE return_reminders SET status=$1,claim_token=$2,claimed_at=clock_timestamp(),lease_until=clock_timestamp()+interval '1 minute',
  dispatch_started_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$4`,[status,crypto.randomUUID(),dispatch,r.id]);},{serialize:false});
 for(const name of ['Unha em gel','Design de sobrancelha','Massagem','Corte Degradê','Maquiagem','Pedicure','Serviço criado livremente 🧡'])await t.test('first/second/third completion keeps one pending reference: '+name,async()=>{
  const sid=await service(6,name),a=await book(sid,{name});await complete(a);const first=await row(a);assert.equal(first.status,'pending');
  const b=await book(sid,{name});await complete(b);assert.equal((await row(a)).status,'suppressed');assert.equal((await row(a)).reason_code,'newer_completion');assert.equal((await row(b)).status,'pending');assert.deepEqual(facts(await row(a)),facts(first));
  const c=await book(sid,{name});await complete(c);assert.equal((await row(a)).status,'suppressed');assert.equal((await row(b)).status,'suppressed');assert.equal((await row(c)).status,'pending');
  assert.equal((await db.getAsync("SELECT count(*)::int n FROM return_reminders WHERE assinatura_id=6 AND service_identity=$1 AND status='pending'",['service:'+sid])).n,1);
 });
 await t.test('different services with same name and different customers are independent',async()=>{
  const sa=await service(),sb=await service();const a=await book(sa),b=await book(sb),c=await book(sa,{phone:'5511988886060'});
  for(const id of [a,b,c])await complete(id);
  for(const id of [a,b,c])assert.equal((await row(id)).status,'pending');
  assert.notEqual((await row(a)).service_identity,(await row(b)).service_identity);assert.notEqual((await row(a)).customer_key,(await row(c)).customer_key);
 });
 await t.test('same phone in A/B cannot suppress another owner',async()=>{
  const sa=await service(6),sb=await service(806);const a=await book(sa),b=await book(sb,{tenant:806});await complete(a);await complete(b,806);
  const newer=await book(sa);await complete(newer);
  assert.equal((await row(a)).status,'suppressed');assert.equal((await row(newer)).status,'pending');assert.equal((await row(b)).status,'pending');assert.notEqual((await row(a)).customer_key,(await row(b)).customer_key);
 });
 for(const status of ['confirmado','cancelado','falta'])await t.test('new '+status+' never suppresses a completed reference',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const before=await row(a);const b=await book(sid);await transitionAppointment(db,6,b,status);
  assert.deepEqual(await row(a),before);assert.equal(await row(b),undefined);
 });
 await t.test('future completion is rejected without suppression or partial changes',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const before=await row(a),b=await book(sid,{future:true});
  await assert.rejects(complete(b),e=>e.statusCode===409);await assert.rejects(db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1",[b]),e=>e.code==='23514');assert.deepEqual(await row(a),before);assert.equal(await row(b),undefined);
 });
 await t.test('canonical phone aliases preserve group identity',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const b=await book(sid,{phone:'(11) 99999-6060'});await complete(b);
  assert.equal((await row(a)).customer_key,(await row(b)).customer_key);assert.equal((await row(a)).status,'suppressed');
 });
 await t.test('renaming service keeps identity and original snapshots',async()=>{
  const sid=await service(6,'Nome original'),a=await book(sid,{name:'Nome original'});await complete(a);const before=await row(a);
  await db.runAsync("UPDATE servicos_assinatura SET nome='Nome novo',ativo=false WHERE id=$1",[sid]);
  const b=await book(sid,{name:'Nome novo'});await complete(b);assert.equal((await row(a)).status,'suppressed');assert.deepEqual(facts(await row(a)),facts(before));assert.equal((await row(b)).service_identity,before.service_identity);assert.equal((await row(b)).service_name_snapshot,'Nome novo');
 });
 await t.test('suppression refresh and completion retries are idempotent',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const b=await book(sid);await complete(b);const first=await row(a),latest=await row(b);
  assert.equal((await refresh(latest)).n,0);assert.equal((await refresh(latest)).n,0);await db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1",[b]);await assert.rejects(complete(b),e=>e.statusCode===409);
  assert.deepEqual(await row(a),first);assert.deepEqual(await row(b),latest);
 });
 for(const terminal of ['sent','suppressed','cancelled','failed','uncertain'])await t.test('terminal '+terminal+' is retained and cannot reopen',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);await setState(r,terminal);const before=await row(a);const b=await book(sid);await complete(b);assert.deepEqual(await row(a),before);
  await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync("UPDATE return_reminders SET status='pending' WHERE id=$1",[r.id]);},{serialize:false}),e=>e.code==='23514');assert.equal((await row(b)).status,'pending');
 });
 await t.test('processing without dispatch intent is suppressed and its claim invalidated',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);await setState(await row(a),'processing');const b=await book(sid);await complete(b);
  const old=await row(a);assert.equal(old.status,'suppressed');assert.equal(old.reason_code,'newer_completion');assert.equal(old.claim_token,null);assert.equal(old.lease_until,null);assert.equal(old.dispatch_started_at,null);
 });
 await t.test('processing with durable dispatch intent becomes uncertain without automatic retry',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);await setState(await row(a),'processing',true);const before=await row(a);const b=await book(sid);await complete(b);
  const old=await row(a);assert.equal(old.status,'uncertain');assert.equal(old.reason_code,'delivery_uncertain');assert.equal(old.claim_token,null);assert.equal(old.lease_until,null);assert.deepEqual(old.dispatch_started_at,before.dispatch_started_at);assert.equal((await row(b)).status,'pending');
 });
 await t.test('uncoordinated metadata writers fail immediately instead of waiting for a group lock',async()=>{
  const sid=await service(),id=await book(sid);await complete(id);const r=await row(id),holding=await db.pool.connect();
  try{await holding.query('BEGIN');await holding.query('SELECT studiofy_return_group_lock($1,$2,$3)',[6,r.customer_key,r.service_identity]);
   await assert.rejects(db.transaction(async c=>{await c.runAsync("SELECT set_config('lock_timeout','250ms',true)");await c.runAsync("UPDATE return_reminders SET status='processing' WHERE id=$1",[r.id]);},{serialize:false}),e=>e.code==='23514');
  }finally{await holding.query('ROLLBACK');holding.release();}assert.equal((await row(id)).status,'pending');
 });
 await t.test('concurrent conclusions leave one pending reference, including native SQL writers',async()=>{
  const sid=await service();const ids=await Promise.all([book(sid),book(sid),book(sid)]);
  await Promise.all(ids.map(id=>db.runAsync("UPDATE agendamentos SET status='concluido' WHERE id=$1",[id])));
  const rows=await db.allAsync('SELECT * FROM return_reminders WHERE service_identity=$1 ORDER BY completed_at DESC,appointment_id DESC',['service:'+sid]);
  assert.equal(rows.length,3);assert.equal(rows[0].status,'pending');assert.deepEqual(rows.slice(1).map(r=>r.status),['suppressed','suppressed']);
 });
 await t.test('a future coordinated claim and new completion serialize on the same group',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const old=await row(a),b=await book(sid),claim=await db.pool.connect();let settled=false;
  try{await claim.query('BEGIN');await claim.query('SELECT studiofy_return_group_lock($1,$2,$3)',[6,old.customer_key,old.service_identity]);
   await claim.query("UPDATE return_reminders SET status='processing',claim_token=$1 WHERE id=$2",[crypto.randomUUID(),old.id]);
   const done=complete(b).finally(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,80));assert.equal(settled,false);await claim.query('COMMIT');await done;
  }finally{await claim.query('ROLLBACK');claim.release();}assert.equal((await row(a)).status,'suppressed');assert.equal((await row(b)).status,'pending');
 });
 await t.test('rollback restores old reference and removes new completion/opportunity',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const old=await row(a),b=await book(sid);
  await assert.rejects(db.transaction(async c=>{await transitionAppointment(c,6,b,'concluido');assert.equal((await c.getAsync('SELECT status FROM return_reminders WHERE appointment_id=$1',[a])).status,'suppressed');throw Error('Synthetic rollback');}),/Synthetic rollback/);
  assert.deepEqual(await row(a),old);assert.equal(await row(b),undefined);assert.equal((await db.getAsync('SELECT status,completed_at FROM agendamentos WHERE id=$1',[b])).status,'confirmado');
 });
 await t.test('suppression failure rolls back new completion and inserted opportunity',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const old=await row(a),b=await book(sid);
  await assert.rejects(db.transaction(async c=>{
   await c.runAsync("CREATE FUNCTION test_reject_suppression() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='suppressed' THEN RAISE EXCEPTION 'Synthetic storage failure'; END IF; RETURN NEW; END $$");
   await c.runAsync('CREATE TRIGGER test_reject_suppression BEFORE UPDATE ON return_reminders FOR EACH ROW EXECUTE FUNCTION test_reject_suppression()');
   await transitionAppointment(c,6,b,'concluido');
  }),e=>e.code==='P0001');assert.deepEqual(await row(a),old);assert.equal(await row(b),undefined);assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[b])).status,'confirmado');
 });
 await t.test('snapshots and original owner remain immutable; M-RETORNO-01 stays blocked',async()=>{
  const sa=await service(),sb=await service(806),a=await book(sa),before=await db.getAsync('SELECT * FROM agendamentos WHERE id=$1',[a]);
  await assert.rejects(db.runAsync("UPDATE agendamentos SET assinatura_id=806,studio_service_id=$1,status='concluido' WHERE id=$2",[sb,a]),e=>e.code==='23514');assert.deepEqual(await db.getAsync('SELECT * FROM agendamentos WHERE id=$1',[a]),before);assert.equal(await row(a),undefined);
  await complete(a);const r=await row(a);await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync("UPDATE return_reminders SET phone_snapshot='5511988886060' WHERE id=$1",[r.id]);}),e=>e.code==='23514');
 });

 for(const dispatch of [false,true])for(const expired of [false,true])await t.test('M-RETORNO-02 freezes invalidated claim: dispatch='+dispatch+' expired='+expired,async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a),oldToken=crypto.randomUUID();
  await db.transaction(async c=>{await group(c,r);await c.runAsync("UPDATE return_reminders SET status='processing',claim_token=$1,claimed_at=clock_timestamp(),lease_until=clock_timestamp()+CASE WHEN $2 THEN interval '-1 minute' ELSE interval '1 minute' END,dispatch_started_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$4",[oldToken,expired,dispatch,r.id]);},{serialize:false});
  const b=await book(sid);await complete(b);const frozen=await row(a);assert.equal(frozen.status,dispatch?'uncertain':'suppressed');assert.equal(frozen.claim_token,null);assert.equal(frozen.lease_until,null);
  const changes=[['claim_token=$2',oldToken],['claim_token=$2',crypto.randomUUID()],["claimed_at=clock_timestamp()"],["lease_until=clock_timestamp()+interval '1 hour'"],["dispatch_started_at=clock_timestamp()+interval '1 second'"],["sent_at=clock_timestamp()"],["provider_message_id='synthetic-false-delivery'"],["reason_code='provider_rejected'"],["attempts=attempts+1"],["next_attempt_at=next_attempt_at+interval '1 hour'"],["updated_at=clock_timestamp()"],["created_at=created_at+interval '1 hour'"],["id=id+1000000"]];
  for(const lock of [false,true])for(const [set,value] of changes){await assert.rejects(db.transaction(async c=>{if(lock)await group(c,r);await c.runAsync('UPDATE return_reminders SET '+set+' WHERE id=$1',value===undefined?[r.id]:[r.id,value]);},{serialize:false}),e=>e.code==='23514');assert.deepEqual(await row(a),frozen);}
 });
 for(const terminal of ['sent','suppressed','cancelled','failed','uncertain'])await t.test('terminal '+terminal+' freezes all fields and permits no-op',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);
  await db.transaction(async c=>{await group(c,r);await c.runAsync("UPDATE return_reminders SET status='processing',claim_token=$1,claimed_at=clock_timestamp() WHERE id=$2",[crypto.randomUUID(),r.id]);await c.runAsync('UPDATE return_reminders SET status=$1,reason_code=$2,claim_token=NULL,lease_until=NULL WHERE id=$3',[terminal,terminal==='uncertain'?'delivery_uncertain':terminal==='suppressed'?'newer_completion':null,r.id]);},{serialize:false});
  const frozen=await row(a);await db.transaction(async c=>{await group(c,r);await c.runAsync('UPDATE return_reminders SET status=status WHERE id=$1',[r.id]);},{serialize:false});assert.deepEqual(await row(a),frozen);
  for(const set of ["status='pending'","claim_token='11111111-1111-4111-8111-111111111111'","sent_at=clock_timestamp()","provider_message_id='false-result'","reason_code='invalid_recipient'","appointment_id=appointment_id+1","assinatura_id=806","customer_key=repeat('a',64)","service_identity='service:999999'","customer_name_snapshot='Changed'","phone_snapshot='5511988886060'","service_name_snapshot='Changed'","completed_at=completed_at+interval '1 day'","eligible_at=eligible_at+interval '1 day'"])await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync('UPDATE return_reminders SET '+set+' WHERE id=$1',[r.id]);},{serialize:false}),e=>e.code==='23514');assert.deepEqual(await row(a),frozen);
 });
 for(const state of ['pending','processing','sent','suppressed','cancelled','failed','uncertain'])await t.test('M-RETORNO-03 '+state+' cannot be deleted or recreated with or without lock',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);if(state!=='pending')await setState(r,state,state==='sent'||state==='uncertain');const frozen=await row(a);
  await assert.rejects(db.runAsync('DELETE FROM return_reminders WHERE id=$1',[r.id]),e=>e.code==='23514');
  await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync('DELETE FROM return_reminders WHERE id=$1',[r.id]);},{serialize:false}),e=>e.code==='23514');
  const insert="INSERT INTO return_reminders(assinatura_id,appointment_id,service_identity,customer_key,customer_name_snapshot,phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at) SELECT assinatura_id,id,'service:'||studio_service_id,studiofy_return_customer_key(assinatura_id,studiofy_return_phone(telefone)),nome_cliente,studiofy_return_phone(telefone),servico_nome,completed_at,((completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days') AT TIME ZONE 'America/Sao_Paulo',((completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days') AT TIME ZONE 'America/Sao_Paulo' FROM agendamentos WHERE id=$1";
  await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync('DELETE FROM return_reminders WHERE id=$1',[r.id]);await c.runAsync(insert,[a]);},{serialize:false}),e=>e.code==='23514');
  await assert.rejects(db.transaction(async c=>{await group(c,r);await c.runAsync(insert,[a]);},{serialize:false}),e=>e.code==='23505');assert.deepEqual(await row(a),frozen);
 });
 await t.test('valid transitions into sent, failed and cancelled remain usable',async()=>{
  for(const terminal of ['sent','failed','cancelled']){const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);await setState(r,'processing',terminal==='sent');await db.transaction(async c=>{await group(c,r);await c.runAsync("UPDATE return_reminders SET status=$1,claim_token=NULL,lease_until=NULL,reason_code=$2,sent_at=CASE WHEN $1='sent' THEN clock_timestamp() ELSE NULL END,provider_message_id=CASE WHEN $1='sent' THEN 'synthetic-result' ELSE NULL END WHERE id=$3",[terminal,terminal==='failed'?'provider_rejected':terminal==='cancelled'?'cancelled':null,r.id]);});assert.equal((await row(a)).status,terminal);}
 });
 await t.test('concurrent terminal updates and DELETE attempts leave history unchanged',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);await setState(r,'sent',true);const frozen=await row(a);
  const outcomes=await Promise.allSettled([db.runAsync('DELETE FROM return_reminders WHERE id=$1',[r.id]),...['sent_at=clock_timestamp()',"claim_token='11111111-1111-4111-8111-111111111111'"].map(set=>db.transaction(async c=>{await group(c,r);await c.runAsync('UPDATE return_reminders SET '+set+' WHERE id=$1',[r.id]);},{serialize:false}))]);assert.ok(outcomes.every(x=>x.status==='rejected'&&x.reason.code==='23514'));assert.deepEqual(await row(a),frozen);
 });
 await t.test('concurrent claim, DELETE, conclusion and suppression retain one latest opportunity',async()=>{
  const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);
  const result=await Promise.allSettled([setState(r,'processing'),db.runAsync('DELETE FROM return_reminders WHERE id=$1',[r.id])]);assert.equal(result[0].status,'fulfilled');assert.equal(result[1].status,'rejected');assert.equal(result[1].reason.code,'23514');
  const b=await book(sid),c=await book(sid);await Promise.all([complete(b),complete(c)]);await Promise.all([refresh(r),refresh(r)]);const rr=await db.allAsync('SELECT * FROM return_reminders WHERE service_identity=$1 ORDER BY completed_at DESC,appointment_id DESC',[r.service_identity]);assert.equal(rr[0].status,'pending');assert.ok(rr.slice(1).every(x=>x.status==='suppressed'));assert.equal(rr.length,3);
 });
 await t.test('complete administrative HTTP account deletion works and rollback preserves terminal history',async()=>{
  const owner=990;await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero) VALUES ($1,'Synthetic removable account','Synthetic owner','11988880000','mercado_pago',5,'11977770000')",[owner]);
  for(const state of ['sent','suppressed','uncertain']){const sid=await service(owner),a=await book(sid,{tenant:owner});await complete(a,owner);await setState(await row(a),state,state!=='suppressed');}
  const ownBefore=await db.allAsync('SELECT * FROM return_reminders WHERE assinatura_id=$1 ORDER BY id',[owner]),otherBefore=await db.allAsync('SELECT * FROM return_reminders WHERE assinatura_id=806 ORDER BY id');
  process.env.LEGACY_ADMIN_EMAIL='return-fix-admin@example.test';process.env.LEGACY_ADMIN_PASSWORD='synthetic-return-fix-password';const express=require('express'),app=express();app.use(express.json());app.use('/api',require('../routes'));const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));
  try{const request=(url,method='GET',body,token)=>nativeFetch('http://127.0.0.1:'+server.address().port+'/api'+url,{method,headers:{'Content-Type':'application/json',...(token?{'x-admin-token':token}:{})},body:body?JSON.stringify(body):undefined});const login=await request('/admin/login','POST',{email:process.env.LEGACY_ADMIN_EMAIL,senha:process.env.LEGACY_ADMIN_PASSWORD});assert.equal(login.status,200);const token=(await login.json()).token;const groups=await (await request('/admin/assinaturas?incluirPendentes=1','GET',undefined,token)).json();const accounts=[...groups.assinaturas,...groups.pendentes];const confirmationToken=accounts.find(x=>Number(x.id)===owner).deleteConfirmationToken;
   await db.runAsync("CREATE FUNCTION test_reject_account_fix() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic rollback'; END $$");await db.runAsync('CREATE TRIGGER test_reject_account_fix BEFORE DELETE ON assinaturas FOR EACH ROW EXECUTE FUNCTION test_reject_account_fix()');assert.equal((await request('/admin/assinaturas/'+owner,'DELETE',{confirmationToken},token)).status,500);assert.deepEqual(await db.allAsync('SELECT * FROM return_reminders WHERE assinatura_id=$1 ORDER BY id',[owner]),ownBefore);await db.runAsync('DROP TRIGGER test_reject_account_fix ON assinaturas');
   assert.equal((await request('/admin/assinaturas/'+owner,'DELETE',{confirmationToken},token)).status,200);assert.equal((await db.getAsync('SELECT count(*)::int n FROM return_reminders WHERE assinatura_id=$1',[owner])).n,0);assert.equal((await db.getAsync('SELECT count(*)::int n FROM assinaturas WHERE id=$1',[owner])).n,0);assert.deepEqual(await db.allAsync('SELECT * FROM return_reminders WHERE assinatura_id=806 ORDER BY id'),otherBefore);
  }finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
 });


 for(const shadow of ['temp_assinaturas','temp_return_reminders','temp_agendamentos','temp_servicos_assinatura','temp_configuracoes','alternate_path','new_connection'])await t.test('M-RETORNO-04 bound relations reject shadowing: '+shadow,async()=>{
  const real='"'+env.schema+'"',alternate='"'+env.schema+'_shadow"';
  const q=sql=>sql.replaceAll('{real}',real);const c=shadow==='new_connection'?new (require('pg').Client)({connectionString:process.env.TEST_DATABASE_URL}):await db.pool.connect();if(shadow==='new_connection')await c.connect();
  try{
   if(shadow==='alternate_path'){await c.query('CREATE SCHEMA '+alternate);for(const table of ['assinaturas','return_reminders','agendamentos','servicos_assinatura','configuracoes'])await c.query('CREATE TABLE '+alternate+'.'+table+' (LIKE '+real+'.'+table+')');await c.query('SET search_path TO '+alternate+',pg_temp,'+real+',public');}
   else{await c.query('SET search_path TO pg_temp,'+real+',public');if(shadow==='temp_assinaturas'||shadow==='new_connection')await c.query('CREATE TEMP TABLE assinaturas(id BIGINT)');else await c.query('CREATE TEMP TABLE '+shadow.slice(5)+' (LIKE '+real+'.'+shadow.slice(5)+')');}
   for(const terminal of ['sent','suppressed','uncertain','failed','cancelled']){
    const sid=await service(),a=await book(sid);await complete(a);const r=await row(a);await setState(r,terminal,terminal==='sent'||terminal==='uncertain');const before=await row(a),ownerBefore=await db.getAsync('SELECT * FROM assinaturas WHERE id=6');
    const acquire=()=>c.query(q('SELECT {real}.studiofy_return_group_lock($1,$2,$3)'),[r.assinatura_id,r.customer_key,r.service_identity]);
    await assert.rejects(c.query(q('DELETE FROM {real}.return_reminders WHERE id=$1'),[r.id]),e=>e.code==='23514');
    await c.query('BEGIN');await acquire();await c.query(q('DELETE FROM {real}.return_reminders WHERE id=$1'),[r.id]);await assert.rejects(c.query('COMMIT'),e=>e.code==='23514');await c.query('ROLLBACK');
    const insert=q("INSERT INTO {real}.return_reminders(assinatura_id,appointment_id,service_identity,customer_key,customer_name_snapshot,phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at) SELECT assinatura_id,id,'service:'||studio_service_id,{real}.studiofy_return_customer_key(assinatura_id,{real}.studiofy_return_phone(telefone)),nome_cliente,{real}.studiofy_return_phone(telefone),servico_nome,completed_at,((completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days') AT TIME ZONE 'America/Sao_Paulo',((completed_at AT TIME ZONE 'America/Sao_Paulo')+interval '7 days') AT TIME ZONE 'America/Sao_Paulo' FROM {real}.agendamentos WHERE id=$1");
    await c.query('BEGIN');await acquire();await c.query(q('DELETE FROM {real}.return_reminders WHERE id=$1'),[r.id]);await c.query('SET LOCAL search_path TO pg_catalog,'+real+',pg_temp');await c.query(insert,[a]);await c.query('SET LOCAL search_path TO '+(shadow==='alternate_path'?alternate+',pg_temp,'+real+',public':'pg_temp,'+real+',public'));await assert.rejects(c.query('COMMIT'),e=>e.code==='23514');await c.query('ROLLBACK');
    await c.query('BEGIN');await acquire();await c.query('SET LOCAL search_path TO pg_catalog,'+real+',pg_temp');await assert.rejects(c.query(insert,[a]),e=>e.code==='23505'||e.code==='23514');await c.query('ROLLBACK');assert.deepEqual(await row(a),before);assert.deepEqual(await db.getAsync('SELECT * FROM assinaturas WHERE id=6'),ownerBefore);
   }
  }finally{await c.query('ROLLBACK');await c.query('SET search_path TO '+real+',public');if(shadow==='alternate_path')await c.query('DROP SCHEMA '+alternate+' CASCADE');else for(const table of ['assinaturas','return_reminders','agendamentos','servicos_assinatura','configuracoes'])await c.query('DROP TABLE IF EXISTS pg_temp.'+table);if(shadow==='new_connection')await c.end();else c.release();}
 });
 await t.test('M-RETORNO-04 supersession uses real reminders and stable lock key across caller paths',async()=>{
  const real='"'+env.schema+'"',sid=await service(),a=await book(sid);await complete(a);const b=await book(sid);await complete(b);const r=await row(b),c=await db.pool.connect();try{const params=[r.assinatura_id,r.customer_key,r.service_identity];const initial=(await c.query('SELECT '+real+'.studiofy_return_group_key($1,$2,$3)::text k',params)).rows[0].k;await c.query('CREATE TEMP TABLE return_reminders (LIKE '+real+'.return_reminders)');await c.query('SET search_path TO pg_temp,public');assert.equal((await c.query('SELECT '+real+'.studiofy_return_group_key($1,$2,$3)::text k',params)).rows[0].k,initial);assert.equal((await c.query('SELECT '+real+'.studiofy_return_supersede_group($1,$2,$3) n',params)).rows[0].n,0);assert.equal((await row(a)).status,'suppressed');assert.equal((await row(b)).status,'pending');}finally{await c.query('SET search_path TO '+real+',public');await c.query('DROP TABLE IF EXISTS pg_temp.return_reminders');c.release();}
 });

 await t.test('historical final records are not backfilled and no network/private logging occurs',async()=>{
  const sid=await service(),id=await book(sid,{status:'concluido'});assert.equal(await row(id),undefined);assert.equal((await db.getAsync('SELECT completed_at FROM agendamentos WHERE id=$1',[id])).completed_at,null);
  assert.equal(networkCalls,0);assert.deepEqual(logs,[]);
 });
 await t.test('024 preserves every legacy fact and quarantines all historical delivery states',async()=>{
  const before=await db.allAsync('SELECT * FROM return_reminders ORDER BY id');
  await require('../database/migrate').migrate(db.pool,env.schema);
  const after=await db.allAsync('SELECT * FROM return_reminders ORDER BY id');
  assert.deepEqual(after.map(({transport_protocol,historical_snapshot_status,establishment_name_snapshot,materialized_at,historical_snapshot_at,snapshot_version,superseded_at,...r})=>{
   assert.equal(transport_protocol,'legacy_simulated');assert.equal(historical_snapshot_status,'unavailable_legacy');
   assert.equal(establishment_name_snapshot,null);assert.equal(materialized_at,null);return r;
  }),before);
  await db.runAsync("INSERT INTO configuracoes(chave,valor) VALUES('return_outbox_delivery_enabled','true') ON CONFLICT(chave) DO UPDATE SET valor='true'");
  await db.runAsync(`CREATE OR REPLACE FUNCTION "${env.schema}".studiofy_return_now() RETURNS timestamptz LANGUAGE sql VOLATILE
   SET search_path=pg_catalog AS $$SELECT '2030-06-03T15:00:00Z'::timestamptz$$`);
  assert.equal((await db.getAsync('SELECT studiofy_return_delivery_open() ready')).ready,true);
  assert.deepEqual(await require('../services/returnReminders').materializeReturnReminders(db),[]);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id IS NOT NULL')).n,0);
 });
});
