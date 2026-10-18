const crypto=require('node:crypto');
const {localNow,addDays}=require('../../services/whatsapp/scheduling');
async function fixture(db){
 const instance='text-'+crypto.randomUUID(),phone='5511999990001';
 const a=await db.runAsync(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento,weekly_hours)
 VALUES('Studio Texto','Responsável','11999990000','mercado_pago',5,'',$1,'ativo','2099-01-01',$2::jsonb)`,[instance,JSON.stringify(Array.from({length:7},()=>[['09:00','18:00']]))]);
 const tenant=a.lastID;
 const service=await db.runAsync("INSERT INTO servicos_assinatura(assinatura_id,nome,preco,duracao,ativo,categoria) VALUES($1,'Massagem',30,30,true,'Bem-estar')",[tenant]);
 const professional=await db.runAsync("INSERT INTO profissionais(assinatura_id,nome,ativo) VALUES($1,'João',true)",[tenant]);
 await db.runAsync('INSERT INTO profissional_servicos(assinatura_id,profissional_id,servico_id) VALUES($1,$2,$3)',[tenant,professional.lastID,service.lastID]);
 const webhook=require('../../evolutionWebhook'),headers={'x-webhook-secret':'conversation-test-secret'};
 const payload=(text,options={})=>({event:'messages.upsert',instance:options.instance||instance,assinatura_id:options.tenant,owner_id:options.tenant,data:{messageTimestamp:options.timestamp,key:{remoteJid:(options.phone||phone)+'@s.whatsapp.net',fromMe:false,id:options.id||crypto.randomUUID()},message:options.quoted||options.replyTo?{extendedTextMessage:{text,contextInfo:{stanzaId:options.replyTo,quotedMessage:options.quoted?{conversation:options.quoted}:undefined}}}:{conversation:text}}});
 const state=(sender=phone)=>db.getAsync('SELECT * FROM whatsapp_conversations WHERE assinatura_id=$1 AND sender=$2',[tenant,sender]);
 const sendMock=async()=>({key:{id:crypto.randomUUID()},status:'PENDING'});
 async function send(text,options={}){
  // Existing happy-path fixtures represent a user reading each new prompt.
  // Advance only the guard's local-time observation, without sleeping or
  // supplying a quote/reference. Burst tests use raw events or rapid:true.
  if(!options.rapid)await db.runAsync("UPDATE whatsapp_conversations SET input_guard=jsonb_set(input_guard,'{at}',to_jsonb((clock_timestamp()-interval '2 seconds')::text),false) WHERE assinatura_id=$1 AND sender=$2",[tenant,options.phone||phone]);
  const current=await state(options.phone||phone);
  const qualified=options.reference?text+' '+options.reference:text;
  const event=payload(qualified,options),result=await webhook.processarWebhookEvolution(event,headers,{deferDelivery:true});
  if(options.drain!==false)await webhook.drain(sendMock);
  return {result,event,state:await state(options.phone||phone)};
 }
 async function review(sender=phone,time='09:00'){
  await send('oi',{phone:sender});await send('1',{phone:sender});await send('1',{phone:sender});
  let c=await state(sender);if(c.state.step==='PROFESSIONAL'){await send('1',{phone:sender});c=await state(sender);}
  const tomorrow=addDays(localNow().date,1),index=c.state.options.findIndex(d=>d>=tomorrow);if(index<0)throw Error('No future day in fixture');
  await send(String(index+1),{phone:sender});c=await state(sender);
  const slot=c.state.options.indexOf(time);if(slot<0)throw Error('Missing fixture time');
  await send(String(slot+1),{phone:sender});await send('Cliente Teste',{phone:sender});return state(sender);
 }
 return {db,tenant,instance,phone,service:service.lastID,professional:professional.lastID,send,payload,state,review,sendMock,headers,webhook};
}
module.exports={fixture};
