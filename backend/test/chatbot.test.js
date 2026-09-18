const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
test('WhatsApp fornece link individual; nao conduz agendamento; webhook autenticado e idempotente',async t=>{
 const env=require('./helpers/postgres').testEnvironment();
 process.env.EVOLUTION_WEBHOOK_SECRET='test-only-secret';process.env.PUBLIC_APP_URL='https://studiofy.example.test';
 const db=require('../database');await db.ready;
 t.after(async()=>{await db.close();await env.cleanup();});
 const webhook=require('../evolutionWebhook'),headers={'x-webhook-secret':'test-only-secret'},sent=[];
 const send=async(instance,phone,text)=>sent.push({instance,phone,text});
 const payload=(text,instance='test-a',id=crypto.randomUUID())=>({event:'messages.upsert',instance,data:{key:{remoteJid:'5511999990001@s.whatsapp.net',fromMe:false,id},message:{conversation:text}}});
 for(const [id,instance,name] of [[1,'test-a','Studio Bella'],[2,'test-b','Espaco Ana']])await db.runAsync("INSERT INTO assinaturas (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status) VALUES ($1,$2,'Dono','5511999990000','mercado_pago',5,'',$3,'ativo')",[id,name,instance]);
 await assert.rejects(webhook.processarWebhookEvolution(payload('oi'),{}, {send}),e=>e.statusCode===401);
 const own=payload('oi');own.data.key.fromMe=true;assert.equal(webhook.extract(own),null);
 for(const jid of ['123@g.us','status@broadcast','123456789012@lid']){const p=payload('oi');p.data.key.remoteJid=jid;assert.equal(webhook.extract(p),null);}
 const p=payload('oi');await Promise.all([webhook.processarWebhookEvolution(p,headers,{send}),webhook.processarWebhookEvolution(p,headers,{send})]);
 assert.equal(sent.length,1);assert.match(sent[0].text,/Studio Bella/);assert.match(sent[0].text,/agendar\/studio-1/);
 await webhook.processarWebhookEvolution(payload('oi','test-b'),headers,{send});assert.match(sent[1].text,/Espaco Ana/);assert.match(sent[1].text,/agendar\/studio-2/);
 for(const text of ['1','Quero conversar com a Ana','14:00'])await webhook.processarWebhookEvolution(payload(text),headers,{send});
 assert.equal(sent.length,2);assert.equal((await db.getAsync('SELECT COUNT(*) AS n FROM agendamentos')).n,0);
 delete require.cache[require.resolve('../evolutionWebhook')];assert.equal((await require('../evolutionWebhook').processarWebhookEvolution(p,headers,{send})).duplicate,true);
 assert.equal(sent.length,2);
 const pending=payload('Ola');await webhook.processarWebhookEvolution(pending,headers,{send:async()=>{throw Error('offline');}});
 const row=await db.getAsync('SELECT * FROM whatsapp_messages WHERE message_id=$1',[pending.data.key.id]);assert.equal(row.status,'pending');
 await db.runAsync('UPDATE whatsapp_messages SET lease_until=0 WHERE id=$1',[row.id]);await webhook.drain(send);assert.equal(sent.length,3);
});
