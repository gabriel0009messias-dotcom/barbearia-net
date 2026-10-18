const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),path=require('node:path');
const {fixture}=require('./helpers/conversation');
const {createConversationProcessor}=require('../services/whatsapp/conversationStore');

test('I-01: durable admission, logical questions and natural clarification A-O',{timeout:180000},async t=>{
  const env=require('./helpers/postgres').testEnvironment();process.env.EVOLUTION_WEBHOOK_SECRET='conversation-test-secret';
  const db=require('../database');await db.ready;t.after(async()=>{await db.close();await env.cleanup();});
  const processor=()=>createConversationProcessor(db);
  const event=(f,text,options={})=>f.webhook.extract(f.payload(text,options));
  const ingest=(f,text,options)=>processor().process(event(f,text,options));
  const drain=f=>f.webhook.drain(f.sendMock);
  const receipt=async e=>await db.getAsync('SELECT * FROM whatsapp_conversation_inbox WHERE instance_key=$1 AND message_id=$2',[e.instance.toLowerCase(),e.messageId]) || db.getAsync('SELECT * FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2',[e.instance.toLowerCase(),e.messageId]);
  const count=async(f,table='agendamentos')=>(await db.getAsync('SELECT count(*)::int n FROM '+table+' WHERE assinatura_id=$1',[f.tenant])).n;
  const run=(name,fn)=>t.test(name,async()=>fn(await fixture(db)));
  async function burst(f,{drainFirst=true,second='1'}={}) {
    await f.send('oi');await ingest(f,'1');if(drainFirst)await drain(f);
    await ingest(f,second);await drain(f);
    const c=await f.state();assert.equal(c.state.step,'SERVICE');assert.ok(c.clarification);assert.equal(await count(f),0);return c;
  }
  async function child(action,payload){
    const code=`const db=require('./database');db.ready.then(async()=>{const p=require('./services/whatsapp/conversationStore').createConversationProcessor(db);const r=await p[${JSON.stringify(action)}](${JSON.stringify(payload)});await db.close();process.send({result:r});process.disconnect();}).catch(e=>{console.error(e.code||e.message);process.exitCode=1;process.disconnect();});`;
    return new Promise((resolve,reject)=>{let result,stderr='';const p=spawn(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});p.stderr.on('data',v=>stderr+=v);p.on('message',m=>result=m.result);p.on('error',reject);p.on('exit',c=>c===0?resolve(result):reject(Error(stderr)));});
  }
  async function crash(f,point,e) {
    const code=`const db=require('./database');db.ready.then(async()=>{
      if(${JSON.stringify(point)}==='before-capture')process.exit(77);
      const crashDb={...db,transaction:work=>db.transaction(tx=>work({...tx,runAsync:async(sql,args)=>{
        if(${JSON.stringify(point)}==='before-advance' && sql.startsWith('UPDATE whatsapp_conversations SET'))process.exit(77);
        return tx.runAsync(sql,args);
      }}))};
      const p=require('./services/whatsapp/conversationStore').createConversationProcessor(crashDb);
      if(${JSON.stringify(point)}==='after-capture')await p.capture(${JSON.stringify(e)});else await p.process(${JSON.stringify(e)});
      process.exit(77);
    }).catch(()=>process.exit(1));`;
    await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['-e',code],{cwd:path.resolve(__dirname,'..'),env:process.env,windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',c=>c===77?resolve():reject(Error('Unexpected crash exit '+c)));});
  }
  await run('A captured A/B for same menu can never select service, even after intermediate delivery',async f=>{
    await f.send('oi');const a=event(f,'1'),b=event(f,'1');await processor().capture(a);await processor().capture(b);
    const original=(await receipt(b)).capture_context;await processor().process(a);await drain(f);await processor().process(b);
    assert.equal((await f.state()).state.step,'SERVICE');assert.deepEqual((await receipt(b)).capture_context,original);assert.equal((await receipt(b)).decision,'captured_obsolete');
  });
  await run('A/F sent between two rapid distinct bare 1 events asks instead of advancing',async f=>{await burst(f);assert.match((await db.getAsync('SELECT response FROM whatsapp_messages WHERE id=$1',[(await f.state()).last_response_id])).response,/Massagem.*\nResponda confirmar ou voltar/s);});
  await run('B a later conscious bare 1 still selects service without quote or token',async f=>{await f.send('oi');await f.send('1');const c=await f.state();assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1',[c.last_response_id])).status,'sent');await new Promise(r=>setTimeout(r,1100));await ingest(f,'1');assert.equal((await f.state()).state.step,'DATE');assert.equal((await f.state()).clarification,null);});
  await run('C two independent workers cannot cross the second question',async f=>{await f.send('oi');await Promise.all([child('process',event(f,'1')),child('process',event(f,'1'))]);await drain(f);assert.equal((await f.state()).state.step,'SERVICE');assert.equal(await count(f),0);});
  await run('D restart between captured A and B preserves the original menu observation',async f=>{
    await f.send('oi');const a=event(f,'1'),b=event(f,'1');
    await processor().capture(a);await processor().capture(b);const original=(await receipt(b)).capture_context;
    await child('process',a);await drain(f);await child('process',b);await drain(f);
    assert.equal((await f.state()).state.step,'SERVICE');assert.deepEqual((await receipt(b)).capture_context,original);
    assert.equal((await receipt(b)).decision,'captured_obsolete');
  });
  await run('E sending preserves pending and requires clarification for repeated old answer',async f=>{
    await f.send('oi');await ingest(f,'1');const c=await f.state();let b;
    await f.webhook.drain(async(...args)=>{if(!b){assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1',[c.last_response_id])).status,'sending');b=event(f,'1');assert.equal((await processor().process(b)).reason,'awaiting_delivery');}return f.sendMock(...args);});
    assert.equal((await receipt(b)).decision,'clarification_requested');assert.equal((await f.state()).state.step,'SERVICE');assert.ok((await f.state()).clarification);
  });
  await run('G current quoted reply resolves an otherwise rapid repeated 1',async f=>{await f.send('oi');await ingest(f,'1');await drain(f);const c=await f.state(),binding=await db.getAsync('SELECT provider_message_id FROM whatsapp_conversation_responses WHERE delivery_id=$1',[c.last_response_id]);await ingest(f,'1',{replyTo:binding.provider_message_id});assert.equal((await f.state()).state.step,'DATE');assert.equal((await f.state()).clarification,null);});
  await run('E delayed delivery without provider timestamp never turns an unseen service question into consent',async f=>{
    await f.send('oi');await ingest(f,'1');await new Promise(resolve=>setTimeout(resolve,1100));
    const e=event(f,'1');assert.equal((await processor().process(e)).reason,'awaiting_delivery');
    assert.equal((await receipt(e)).capture_context.status,'pending');await drain(f);
    assert.equal((await f.state()).state.step,'SERVICE');assert.ok((await f.state()).clarification);
    assert.equal((await receipt(e)).decision,'clarification_requested');assert.equal(await count(f),0);
  });
  await run('H old quoted reply never falls back to bare 1',async f=>{await f.send('oi');const menu=await f.state(),binding=await db.getAsync('SELECT provider_message_id FROM whatsapp_conversation_responses WHERE delivery_id=$1',[menu.last_response_id]);await ingest(f,'1');await drain(f);const c=await f.state();await ingest(f,'1',{replyTo:binding.provider_message_id});assert.deepEqual((await f.state()).state,c.state);assert.equal((await f.state()).question_id,c.question_id);});
  await run('I different 1/2 in a burst also needs clarification',async f=>{await db.runAsync("INSERT INTO servicos_assinatura(assinatura_id,nome,preco,duracao,ativo) VALUES($1,'Segundo serviço',40,30,true)",[f.tenant]);const c=await burst(f,{second:'2'});assert.equal(c.clarification.input,'2');});
  await run('J duplicate ID reuses original observation and cannot replace payload',async f=>{await f.send('oi');const e=event(f,'1');await processor().capture(e);const original=await receipt(e);await processor().process(e);await drain(f);await processor().process(e);assert.deepEqual((await receipt(e)).capture_context,original.capture_context);assert.equal((await f.state()).version,2);assert.equal((await processor().process({...e,text:'2'})).reason,'event_identity_mismatch');await assert.rejects(db.runAsync("UPDATE whatsapp_conversation_inbox SET capture_context='{}'::jsonb WHERE instance_key=$1 AND message_id=$2",[f.instance,e.messageId]),e=>e.code==='23514');});
  await run('K repeated final consent has one booking, one 020 message and no automatic menu',async f=>{await f.review();await Promise.all([ingest(f,'confirmar'),ingest(f,'sim')]);await drain(f);assert.equal(await count(f),1);assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages WHERE assinatura_id=$1 AND booking_confirmation_appointment_id IS NOT NULL',[f.tenant])).n,1);assert.equal((await f.state()).state.step,'COMPLETE');});
  for(const mode of ['same-second','adjacent-seconds','absent','late','future'])await run('L timestamps '+mode+' cannot bypass burst protection',async f=>{
    await f.send('oi');const stamp=Math.floor(Date.now()/1000),a=mode==='absent'?undefined:stamp;
    const b=mode==='absent'?undefined:mode==='same-second'?stamp:mode==='adjacent-seconds'?stamp+1:mode==='late'?1:stamp+120;
    await ingest(f,'1',{timestamp:a});await drain(f);await ingest(f,'1',{timestamp:b});await drain(f);assert.equal((await f.state()).state.step,'SERVICE');assert.equal(await count(f),0);
  });
  await run('M crash before capture has no receipt or transition; retry starts once',async f=>{await f.send('oi');const e=event(f,'1');assert.equal(await receipt(e),undefined);await child('process',e);await child('process',e);assert.equal((await f.state()).state.step,'SERVICE');assert.equal((await f.state()).version,2);});
  await run('M crash after capture: fresh worker consumes original observation',async f=>{await f.send('oi');const e=event(f,'1');await child('capture',e);const r=await receipt(e);assert.equal(r.decision,'captured');await child('consumePending');assert.equal((await f.state()).state.step,'SERVICE');assert.equal((await receipt(e)).captured_event,null);});
  await run('M processing rollback preserves capture, no advance and safe retry',async f=>{await f.send('oi');const e=event(f,'1'),before=await f.state();const broken={...db,transaction:work=>db.transaction(async tx=>{await work(tx);throw Error('synthetic crash before commit');})};await assert.rejects(createConversationProcessor(broken).process(e),/synthetic crash/);assert.equal((await receipt(e)).decision,'captured');assert.equal((await f.state()).version,before.version);await child('consumePending');assert.equal((await f.state()).version,before.version+1);});
  await run('M crash after committed advance: replay never advances again',async f=>{await f.send('oi');const e=event(f,'1');await child('process',e);const before=await f.state();await child('process',e);assert.deepEqual(await f.state(),before);});
  for(const word of ['confirmar','sim'])await run('N natural clarification '+word+' selects only the candidate',async f=>{await burst(f);await ingest(f,word);assert.equal((await f.state()).state.step,'DATE');assert.equal((await f.state()).clarification,null);assert.equal(await count(f),0);});
  await run('N voltar cancels candidate and old confirmation cannot apply it',async f=>{await burst(f);const old=event(f,'confirmar');await processor().capture(old);await ingest(f,'voltar');await drain(f);await processor().process(old);assert.equal((await f.state()).state.step,'SERVICE');assert.equal((await f.state()).clarification,null);});
  await run('N concurrent confirmations from the same challenge advance once',async f=>{await burst(f);const a=event(f,'confirmar'),b=event(f,'confirmar');await processor().capture(a);await processor().capture(b);await Promise.all([child('process',a),child('process',b)]);assert.equal((await f.state()).state.step,'DATE');assert.equal((await f.state()).clarification,null);});
  await run('N repeated challenge answer after advance does not act on next question',async f=>{await burst(f);await ingest(f,'confirmar');await drain(f);await ingest(f,'confirmar');assert.equal((await f.state()).state.step,'DATE');assert.equal(await count(f),0);});
  await run('N fast confirmation before challenge delivery remains pending then selects once',async f=>{await f.send('oi');await ingest(f,'1');await drain(f);await ingest(f,'1');const e=event(f,'confirmar');assert.equal((await processor().process(e)).reason,'awaiting_delivery');await drain(f);assert.equal((await f.state()).state.step,'DATE');assert.equal((await receipt(e)).decision,'processed');});
  await run('N restart during challenge preserves candidate and original question',async f=>{await burst(f);const c=await f.state();await child('process',event(f,'confirmar'));assert.equal((await f.state()).state.step,'DATE');assert.notEqual((await f.state()).question_id,c.question_id);});
  for(const reset of ['expiry','menu','recomecar'])await run('O '+reset+' invalidates captured clarification consent',async f=>{await burst(f);const e=event(f,'confirmar');await processor().capture(e);if(reset==='expiry')await db.runAsync("UPDATE whatsapp_conversations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[(await f.state()).id]);else await ingest(f,reset);await processor().process(e);assert.equal((await f.state()).state.step,'MENU');assert.equal((await f.state()).clarification,null);assert.equal(await count(f),0);});
  await run('logical question survives invalid re-prompt while delivery/version change',async f=>{await f.send('oi');const c=await f.state();await ingest(f,'999');await drain(f);const after=await f.state();assert.equal(after.question_id,c.question_id);assert.notEqual(after.reference,c.reference);assert.equal(after.version,c.version+1);});
  await run('admission commits while processing advisory lock is occupied',async f=>{await f.send('oi');const holder=await db.pool.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()),1)');try{const e=event(f,'1');const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Admission waited on processing lock')),1500);timer.unref();});await Promise.race([processor().capture(e),timeout]);assert.equal((await receipt(e)).decision,'captured');}finally{await holder.query('ROLLBACK');holder.release();}});
  await run('admission commits while the account is FOR UPDATE locked; restart preserves its old question',async f=>{
    await f.send('oi');const before=await f.state(),holder=await db.pool.connect();await holder.query('BEGIN');await holder.query('SELECT id FROM assinaturas WHERE id=$1 FOR UPDATE',[f.tenant]);
    const e=event(f,'1');try{const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Admission waited on account FK lock')),1500);timer.unref();});await Promise.race([processor().capture(e),timeout]);assert.equal((await receipt(e)).capture_context.question_id,before.question_id);}finally{await holder.query('ROLLBACK');holder.release();}
    await ingest(f,'1');await drain(f);await child('consumePending');assert.equal((await f.state()).state.step,'SERVICE');assert.equal((await receipt(e)).decision,'captured_obsolete');
  });
  for(const point of ['before-capture','after-capture','before-advance','after-advance'])await run('M abrupt process exit '+point+' recovers exactly once',async f=>{
    await f.send('oi');const e=event(f,'1'),before=await f.state();await crash(f,point,e);
    if(point==='before-capture'){assert.equal(await receipt(e),undefined);assert.equal((await f.state()).version,before.version);await processor().process(e);}
    else {assert.equal((await receipt(e)).decision,point==='after-advance'?'processed':'captured');await child('consumePending');}
    await processor().process(e);assert.equal((await f.state()).version,before.version+1);assert.equal((await f.state()).state.step,'SERVICE');
  });
  await run('same logical question accepts an already captured answer after an invalid re-prompt',async f=>{
    await f.send('oi');const before=await f.state(),e=event(f,'1');await processor().capture(e);await ingest(f,'???');assert.equal((await f.state()).question_id,before.question_id);await drain(f);await processor().process(e);assert.equal((await f.state()).state.step,'SERVICE');
  });
  await run('delivered logical question stays observable while its invalid re-prompt is pending',async f=>{
    await f.send('oi');await f.send('1');await new Promise(resolve=>setTimeout(resolve,1100));
    const before=await f.state();await ingest(f,'???');assert.equal((await f.state()).question_id,before.question_id);
    const e=event(f,'1');assert.equal((await processor().process(e)).reason,'awaiting_delivery');
    const observation=(await receipt(e)).capture_context;assert.equal(observation.status,'pending');assert.equal(observation.question_delivered,true);
    await drain(f);assert.equal((await f.state()).state.step,'DATE');assert.equal((await f.state()).clarification,null);
  });
  await run('quoted current logical question survives a later delivery revision and its timestamp',async f=>{
    await f.send('oi');const before=await f.state(),binding=await db.getAsync('SELECT provider_message_id FROM whatsapp_conversation_responses WHERE delivery_id=$1',[before.last_response_id]);
    await ingest(f,'???');await drain(f);await db.runAsync("UPDATE whatsapp_conversations SET updated_at=updated_at+interval '2 seconds' WHERE id=$1",[before.id]);
    await ingest(f,'1',{timestamp:Math.floor(new Date(before.question_started_at).getTime()/1000),replyTo:binding.provider_message_id});
    assert.equal((await f.state()).state.step,'SERVICE');
  });
  await run('rapid review 2 then edit 2 cannot silently change the professional',async f=>{
    await f.review();await ingest(f,'2');await drain(f);await ingest(f,'2');
    const c=await f.state();assert.equal(c.state.step,'EDIT');assert.equal(c.clarification.input,'2');assert.equal(await count(f),0);
  });
  await run('capture is not a tenant or quote authority supplied by a caller',async f=>{const other=await fixture(db);await f.send('oi');const e=event(f,'1');await processor().process({...e,tenant:other.tenant,question_id:crypto.randomUUID(),capture_context:{question_id:crypto.randomUUID()}});assert.equal((await f.state()).state.step,'SERVICE');assert.equal(await other.state(),undefined);});
});
