const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture} = require('./helpers/conversation');
test('real delayed greeting burst retains one name prompt, then saves Hugo once and opens menu',async t=>{
  const env=require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET='conversation-test-secret';
  const db=require('../database');await db.ready;
  t.after(async()=>{await db.close();await env.cleanup();});
  const {createConversationProcessor}=require('../services/whatsapp/conversationStore');
  for(const mode of ['sequential','concurrent','captured-before-question','while-sending','delivered-before-processing'])await t.test(mode,async()=>{
    const f=await fixture(db,{known:false}),phone='551188887777';
    const processor=createConversationProcessor(db),base=Math.floor(Date.now()/1000);
    // Same measured timestamp gaps: greetings sent 67/49 seconds before intake.
    const a=f.payload('oi',{phone,timestamp:base-67}),b=f.payload('bom dia',{phone,timestamp:base-49});
    const ingest=e=>f.webhook.processarWebhookEvolution(e,f.headers,{deferDelivery:true});
    if(mode==='concurrent')await Promise.all([ingest(a),ingest(b)]);
    else if(mode==='captured-before-question'){
      await processor.capture(f.webhook.extract(a));await processor.capture(f.webhook.extract(b));
      await processor.process(f.webhook.extract(b));await processor.process(f.webhook.extract(a));
    }else await ingest(a);
    let sends=0;
    const send=async(instance,destination,text)=>{sends++;assert.equal(instance,f.instance);assert.equal(destination,phone);assert.doesNotMatch(text,/etapa anterior/);return {key:{id:'synthetic-greeting-'+sends},status:'PENDING'};};
    if(mode==='while-sending')await f.webhook.drain(async(...args)=>{await ingest(b);return send(...args);});
    else if(mode==='delivered-before-processing'){await f.webhook.drain(send);await ingest(b);}
    else {if(mode==='sequential')await ingest(b);await f.webhook.drain(send);}
    let c=await f.state(phone);assert.equal(c.state.step,'ASK_NAME');assert.equal(c.version,1);
    const rows=await db.allAsync('SELECT response,status FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant]);
    assert.equal(rows.length,1);assert.match(rows[0].response,/qual.*nome/i);assert.equal(rows[0].status,'sent');
    assert.equal(sends,1);
    const hugo=f.payload('hugo',{phone,timestamp:Math.floor(Date.now()/1000)});
    await ingest(hugo);await f.webhook.drain(send);
    c=await f.state(phone);assert.equal(c.state.step,'MENU');assert.equal(c.version,2);
    const customer=await db.getAsync('SELECT id,nome,telefone FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,phone]);
    assert.equal(customer.nome,'hugo');assert.equal(customer.telefone,phone);assert.equal(sends,2);
    const result=await ingest(hugo);assert.equal(result.duplicate,true);await f.webhook.drain(send);assert.equal(sends,2);
    const messages=await db.allAsync('SELECT response FROM whatsapp_messages WHERE assinatura_id=$1 ORDER BY id',[f.tenant]);
    assert.equal(messages.length,2);assert.match(messages[1].response,/Realizar agendamento/);
    assert.doesNotMatch(messages.map(r=>r.response).join('\n'),/etapa anterior/);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM clientes WHERE assinatura_id=$1',[f.tenant])).n,1);
  });
  await t.test('production wake happens after durable intake without waiting for the recovery interval',async()=>{
    const f=await fixture(db,{known:false});let signal, sends=0;
    const sent=new Promise(r=>signal=r);
    const worker=f.webhook.startWorker({send:async()=>{sends++;signal();return f.sendMock();}});
    try{
      assert.equal(f.webhook.startWorker(),worker);
      await f.webhook.processarWebhookEvolution(f.payload('oi'),f.headers,{deferDelivery:true});
      const timeout=setTimeout(()=>signal('timeout'),5000);
      assert.notEqual(await sent,'timeout');clearTimeout(timeout);
      // Stop scheduling, but wait for durable finalization of this live delivery.
      for(let i=0;i<100;i++){
        const row=await db.getAsync('SELECT status FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant]);
        if(row?.status==='sent')break;
        await new Promise(r=>setTimeout(r,10));
      }
      assert.equal(sends,1);
      assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant])).status,'sent');
    }finally{worker.stop();}
  });
});
