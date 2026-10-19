const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./helpers/conversation');
const { customerName, identifyCustomer } = require('../services/whatsapp/customerIdentity');
const { createConversationProcessor } = require('../services/whatsapp/conversationStore');
const { localNow, addDays } = require('../services/whatsapp/scheduling');

test('WhatsApp experience: persistent contact, official booking/cancellation, safe inbound and fallback', {timeout:180000}, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'conversation-test-secret';
  const db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const get = (sql,args=[]) => db.getAsync(sql,args), q = (sql,args=[]) => db.runAsync(sql,args);
  const contact = f => get('SELECT * FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,f.phone]);
  const count = async f => (await get('SELECT count(*)::int n FROM agendamentos WHERE assinatura_id=$1',[f.tenant])).n;
  const latest = f => get('SELECT * FROM whatsapp_messages WHERE assinatura_id=$1 ORDER BY id DESC LIMIT 1',[f.tenant]);
  const run = (name, fn) => t.test(name,async () => fn(await fixture(db,{known:false})));
  async function register(f,name='Ana Silva') { await f.send('quero reservar!'); assert.equal((await f.state()).state.step,'ASK_NAME'); await f.send(name); assert.equal((await f.state()).state.step,'MENU'); }

  for (const text of ['oi','boa tarde','tem horário amanhã?','.','agendamento','quero cortar o cabelo']) await run('1-4 arbitrary first message asks name: '+text,async f=>{
    await f.send(text); assert.equal((await f.state()).state.step,'ASK_NAME');
    assert.match((await latest(f)).response,/Antes de começarmos, qual é o seu nome/);
    assert.equal((await contact(f)).telefone,f.phone); assert.equal((await contact(f)).nome,'');
  });
  await run('5-7/40-43 contact is normalized, persistent, tenant-scoped, independent from appointment beneficiary',async f=>{
    await register(f,'  Ana   Silva  '); assert.equal((await contact(f)).nome,'Ana Silva');
    await q("UPDATE whatsapp_conversations SET expires_at=clock_timestamp()-interval '1 second' WHERE assinatura_id=$1",[f.tenant]);
    await f.send('qualquer outra frase'); assert.equal((await f.state()).state.step,'MENU'); assert.match((await latest(f)).response,/Olá, Ana Silva/);
    const other=await fixture(db,{known:false}); await other.send('oi'); assert.equal((await other.state()).state.step,'ASK_NAME');
    await other.send('Outro Nome'); assert.equal((await contact(f)).nome,'Ana Silva'); assert.equal((await contact(other)).nome,'Outro Nome');
    await f.review(); await f.send('6'); assert.equal((await f.state()).state.step,'THIRD_PARTY_NAME'); await f.send('Maria Silva');
    assert.equal((await contact(f)).nome,'Ana Silva'); await f.send('5'); await f.send('Prefiro ambiente tranquilo'); await f.send('1');
    const a=await get('SELECT * FROM agendamentos WHERE assinatura_id=$1',[f.tenant]);
    assert.equal(a.nome_cliente,'Maria Silva'); assert.equal(a.telefone,f.phone); assert.equal(a.cliente_id,(await contact(f)).id);
    assert.equal(a.origem,'whatsapp'); assert.equal(a.observacao,'Prefiro ambiente tranquilo');
    await f.send('menu'); assert.match((await latest(f)).response,/Ana Silva/);
  });
  await run('8-9 two first events, duplicate provider ID and concurrent identity inserts create one contact',async f=>{
    const e=f.payload('oi'); await Promise.all([f.webhook.processarWebhookEvolution(e,f.headers,{deferDelivery:true}),f.webhook.processarWebhookEvolution(e,f.headers,{deferDelivery:true}),f.webhook.processarWebhookEvolution(f.payload('.'),f.headers,{deferDelivery:true})]);
    await Promise.all([identifyCustomer(db,f.tenant,f.phone),identifyCustomer(db,f.tenant,f.phone)]);
    assert.equal((await get('SELECT count(*)::int n FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,f.phone])).n,1);
    assert.equal((await contact(f)).nome,''); assert.equal((await f.state()).state.step,'ASK_NAME');
  });
  await run('5/9/43/51 two OS processes and restart preserve one contact and known name',async f=>{
    const {execFile}=require('node:child_process'),path=require('node:path');
    const child=event=>new Promise((resolve,reject)=>{
      const code=`const db=require('./database');db.ready.then(()=>require('./services/whatsapp/conversationStore').createConversationProcessor(db).process(${JSON.stringify(event)})).then(()=>db.close()).catch(()=>{process.exitCode=1});`;
      execFile(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true},e=>e?reject(e):resolve());
    });
    const event=f.webhook.extract(f.payload('oi'));await Promise.all([child(event),child(event)]);
    assert.equal((await get('SELECT count(*)::int n FROM clientes WHERE assinatura_id=$1',[f.tenant])).n,1);
    await f.webhook.drain(f.sendMock);await f.send('Nome Persistido');
    await q("UPDATE whatsapp_conversations SET expires_at=clock_timestamp()-interval '1 second' WHERE assinatura_id=$1",[f.tenant]);
    await child(f.webhook.extract(f.payload('.')));assert.equal((await f.state()).state.step,'MENU');assert.equal((await contact(f)).nome,'Nome Persistido');
    assert.match((await latest(f)).response,/Nome Persistido/);
  });
  await run('10-14 rejected envelopes never create contact/session; wrong secret is 401',async f=>{
    const envelopes=[];const fromMe=f.payload('oi');fromMe.data.key.fromMe=true;envelopes.push(fromMe);
    const group=f.payload('oi');group.data.key.remoteJid='1234567890123@g.us';envelopes.push(group);
    envelopes.push({...f.payload('oi'),event:'not.messages'});
    const media=f.payload('oi');media.data.message={imageMessage:{caption:'oi'}};envelopes.push(media);
    const wrong=f.payload('oi');wrong.instance='unowned-synthetic-instance';envelopes.push(wrong);
    for(const event of envelopes){const r=await f.webhook.processarWebhookEvolution(event,f.headers,{deferDelivery:true});assert.equal(r.ignored,true);}
    await assert.rejects(f.webhook.processarWebhookEvolution(f.payload('oi'),{'x-webhook-secret':'invalid'},{deferDelivery:true}),e=>e.statusCode===401);
    assert.equal(await contact(f),undefined); assert.equal(await f.state(),undefined);
  });
  await run('15-20 menu, prices, official address, navigation and invalid options preserve contact',async f=>{
    await register(f); for(const s of ['Realizar agendamento','Preços','Endereço','Cancelar agendamento']) assert.ok((await latest(f)).response.includes(s));
    await f.send('2'); assert.match((await latest(f)).response,/Massagem.*30,00/); await f.send('agendar');assert.equal((await f.state()).state.step,'SERVICE');
    await f.send('menu'); await f.send('3');assert.match((await latest(f)).response,/ainda não cadastrou/);await f.send('voltar');
    const state=(await f.state()).state;await f.send('opção impossível');assert.deepEqual((await f.state()).state,state);
    await f.send('recomeçar');assert.equal((await f.state()).state.step,'MENU');assert.equal((await contact(f)).nome,'Ana Silva');
  });
  await run('21-39 official catalog/availability/revalidation/idempotency, Agenda and historical confirmation',async f=>{
    await register(f);await f.review();let c=await f.state();assert.equal(c.state.name,'Ana Silva');assert.equal(c.state.step,'REVIEW');
    assert.equal(c.state.service.id,f.service);assert.equal(c.state.professional.id,f.professional);
    const official=await require('../services/studiofy').createStudio(db).times(f.tenant,c.state.date,f.service,f.professional);assert.ok(official.includes(c.state.time));
    assert.match((await latest(f)).response,/Profissional: João/);
    const p=f.payload('1'); await Promise.all([f.webhook.processarWebhookEvolution(p,f.headers,{deferDelivery:true}),f.webhook.processarWebhookEvolution(p,f.headers,{deferDelivery:true})]);
    assert.equal(await count(f),1);const a=await get('SELECT a.*,p.nome AS profissional FROM agendamentos a LEFT JOIN profissionais p ON p.id=a.profissional_id AND p.assinatura_id=a.assinatura_id WHERE a.assinatura_id=$1',[f.tenant]);
    assert.equal(a.nome_cliente,'Ana Silva');assert.equal(a.preco,30);assert.equal(a.duracao,30);assert.equal(a.profissional,'João');
    await q("UPDATE profissionais SET nome='Novo nome' WHERE id=$1",[f.professional]);await q('UPDATE servicos_assinatura SET preco=80 WHERE id=$1',[f.service]);
    await f.webhook.drain(f.sendMock);const confirmations=await db.allAsync('SELECT * FROM whatsapp_messages WHERE assinatura_id=$1 AND booking_confirmation_appointment_id IS NOT NULL',[f.tenant]);
    assert.equal(confirmations.length,1);assert.equal(confirmations[0].status,'sent');assert.match(confirmations[0].response,/Profissional: João/);assert.match(confirmations[0].response,/30,00/);
    await f.send('confirmar');assert.equal(await count(f),1);
  });
  await run('32-33 slot lost after review returns to official availability without conflict',async f=>{
    await register(f);await f.review();const s=(await f.state()).state;
    await require('../services/studiofy').createStudio(db).book(f.tenant,{nome_cliente:'Other client',telefone:'11999990002',servico_id:f.service,profissional_id:f.professional,data:s.date,hora:s.time});
    await f.send('1');assert.equal(await count(f),1);assert.notEqual((await f.state()).state.step,'COMPLETE');assert.match((await latest(f)).response,/indisponível/);
  });
  await run('40 name override is appointment-only; invalid names/observation cannot advance',async f=>{
    for(const bad of ['<b>Ana</b>','12345','A','\u202eAna','Ana\nSilva'])assert.equal(customerName(bad),null);
    await register(f);await f.review();await f.send('4');await f.send('<b>Nome</b>');assert.equal((await f.state()).state.step,'NAME');await f.send('Nome Reserva');
    assert.equal((await contact(f)).nome,'Ana Silva');assert.equal((await f.state()).state.name,'Nome Reserva');
    await f.send('5');await f.send('<script>');assert.equal((await f.state()).state.step,'OBSERVATION');await f.send('0');assert.equal((await f.state()).state.step,'REVIEW');
  });
  await run('42 invalid/incomplete tenant profile asks again; global legacy profile is never adopted',async f=>{
    await q("INSERT INTO clientes(nome,telefone) VALUES('Global private name',$1)",[f.phone]);
    await f.send('oi');assert.equal((await f.state()).state.step,'ASK_NAME');await f.send('123');assert.equal((await f.state()).state.step,'ASK_NAME');
    await f.send('Nome Seguro');assert.equal((await contact(f)).nome,'Nome Seguro');
    assert.equal((await get('SELECT nome FROM clientes WHERE assinatura_id IS NULL AND telefone=$1',[f.phone])).nome,'Global private name');
  });
  await run('44-48 contact cancellation uses official public policy, confirms and isolates tenants/phones',async f=>{
    await register(f);await f.review();await f.send('1');await f.send('menu');await f.send('4');assert.equal((await f.state()).state.step,'CANCEL');
    await f.send('1');assert.equal((await f.state()).state.step,'CANCEL_REVIEW');let a=await get('SELECT * FROM agendamentos WHERE assinatura_id=$1',[f.tenant]);assert.equal(a.status,'confirmado');
    const access=require('../services/publicBookings').createPublicBookings(db);
    assert.deepEqual(await access.forContact(f.tenant,'5511999990002'),[]);
    await assert.rejects(access.cancelForContact(f.tenant,'5511999990002',a.id),e=>e.statusCode===404);
    const other=await fixture(db,{known:false});await assert.rejects(access.cancelForContact(other.tenant,f.phone,a.id),e=>e.statusCode===404);
    await f.send('1');a=await get('SELECT * FROM agendamentos WHERE id=$1',[a.id]);assert.equal(a.status,'cancelado');
    assert.ok((await require('../services/studiofy').createStudio(db).times(f.tenant,a.data,f.service,f.professional)).includes(a.hora));
  });
  await run('44 public appointment for the verified phone uses the same cancellation domain without WhatsApp action',async f=>{
    await register(f);const day=addDays(localNow().date,1),studio=require('../services/studiofy').createStudio(db);
    const booking=await db.transaction(c=>require('../services/bookingRequests').confirmBooking(c,require('../services/studiofy').createStudio(c),f.tenant,{nome_cliente:'Public contact',telefone:f.phone,servico_id:f.service,profissional_id:f.professional,data:day,hora:'09:00'},crypto.randomBytes(32).toString('hex')));
    await f.send('4');assert.equal((await f.state()).state.options.length,1);await f.send('1');await f.send('1');assert.equal((await require('../services/publicBookings').createPublicBookings(db).get(booking.token)).status,'cancelado');
  });
  await run('49-51/63-66 list/buttons/native reply IDs feed same state and old question never advances',async f=>{
    await register(f);const old=(await f.state()).question_id;
    for(const type of ['list','buttons','native']){
      await f.send('menu');const c=await f.state(),id=`sf:${c.question_id}:1`,e=f.payload('unused');
      e.data.message=type==='list'?{listResponseMessage:{singleSelectReply:{selectedRowId:id}}}:type==='buttons'?{buttonsResponseMessage:{selectedButtonId:id}}:{interactiveResponseMessage:{nativeFlowResponseMessage:{paramsJson:JSON.stringify({id})}}};
      await f.webhook.processarWebhookEvolution(e,f.headers,{deferDelivery:true});await f.webhook.drain(f.sendMock);assert.equal((await f.state()).state.step,'SERVICE');
      const s=await f.state();const stale=f.payload('unused');stale.data.message={buttonsResponseMessage:{selectedButtonId:`sf:${old}:1`}};
      await createConversationProcessor(db).process(f.webhook.extract(stale));assert.equal((await f.state()).question_id,s.question_id);assert.deepEqual((await f.state()).state,s.state);
      await f.webhook.drain(f.sendMock);
    }
    const c=await f.state(),invalid=f.payload('unused');invalid.data.message={interactiveResponseMessage:{nativeFlowResponseMessage:{paramsJson:'{'}}};
    assert.equal((await f.webhook.processarWebhookEvolution(invalid,f.headers,{deferDelivery:true})).ignored,true);assert.deepEqual((await f.state()).state,c.state);
  });
  await run('67-70 diagnostics expose reason/state/hash only, never content, phone, key or secret',async f=>{
    const logs=[];const old=console.info;console.info=(...args)=>logs.push(args.join(' '));
    try { await f.send('PRIVATE_MESSAGE_CANARY');await f.send('Ana Silva');const e=f.payload('PRIVATE_MESSAGE_CANARY');e.apikey='PRIVATE_KEY_CANARY';await f.webhook.processarWebhookEvolution(e,f.headers,{deferDelivery:true});await assert.rejects(f.webhook.processarWebhookEvolution(e,{'x-webhook-secret':'PRIVATE_SECRET_CANARY'})); }
    finally{console.info=old;}
    const text=logs.join('\n');assert.match(text,/inbound_routed/);assert.match(text,/conversation_transition/);assert.match(text,/unauthorized/);
    for(const forbidden of ['PRIVATE_MESSAGE_CANARY','PRIVATE_KEY_CANARY','PRIVATE_SECRET_CANARY',f.phone,'conversation-test-secret'])assert.ok(!text.includes(forbidden));
  });
  await run('database/customer guards and policies remain fail-closed with no seed',async f=>{
    await register(f);const other=await fixture(db,{known:false});const c=await contact(f);
    await assert.rejects(q('UPDATE clientes SET assinatura_id=$1 WHERE id=$2',[other.tenant,c.id]),e=>e.code==='23514');
    const body={nome_cliente:'Synthetic other contact',telefone:other.phone,servico_id:other.service,profissional_id:other.professional,data:addDays(localNow().date,1),hora:'09:00'};
    const a=await require('../services/studiofy').createStudio(db).book(other.tenant,body);
    await assert.rejects(q('UPDATE agendamentos SET cliente_id=$1 WHERE id=$2',[c.id,a.id]),e=>e.code==='23514');
    await require('../services/agenda').transitionAppointment(db,other.tenant,a.id,'cancelado');
    await assert.rejects(q("UPDATE agendamentos SET observacao='changed after finalization' WHERE id=$1",[a.id]),e=>e.code==='23514');
    assert.equal((await get('SELECT studiofy_appointment_transport_allowed($1) allowed',[f.tenant])).allowed,false);
    assert.equal(await get("SELECT valor FROM configuracoes WHERE chave='return_outbox_delivery_enabled'"),undefined);
    for(const bad of ['sendText','WPPConnect','axios','fetch('])assert.ok(!require('fs').readFileSync(require.resolve('../services/whatsapp/conversationFlow'),'utf8').includes(bad));
  });
});
