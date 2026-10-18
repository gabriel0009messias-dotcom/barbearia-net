const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg'),{migrate}=require('../database/migrate');
const {fingerprint}=require('../services/whatsapp/conversationCapture');

test('022 I-01: populated 021 upgrade, rollback and original pending correlation',async t=>{
  const env=require('./helpers/postgres').testEnvironment(),pool=new Pool(require('../database/config').connectionConfig()),client=await pool.connect();
  t.after(async()=>{client.release();await pool.end();await env.cleanup();});
  const directory=path.join(__dirname,'../database/migrations'),sql=fs.readFileSync(path.join(directory,'022_whatsapp_inbound_correlation.sql'),'utf8');
  await client.query('BEGIN');await client.query('CREATE SCHEMA "'+env.schema+'"');await client.query('SET LOCAL search_path TO "'+env.schema+'",public');
  await client.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
  await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
  for(const name of fs.readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<'022').sort()){
    const text=fs.readFileSync(path.join(directory,name),'utf8');await client.query(text);
    await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,crypto.createHash('sha256').update(text).digest('hex')]);
  }
  await client.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES(41001,'Upgrade','Pessoa','11999990000','mercado_pago',5,'','upgrade-i01','ativo','2099-01-01')");
  const epoch=(await client.query("SELECT conversation_epoch FROM evolution_instance_owners WHERE instance_key='upgrade-i01'")).rows[0].conversation_epoch;
  const delivery=(await client.query("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,conversation_managed,status) VALUES(41001,'upgrade-i01','5511999990001','prompt','Menu',true,'sent') RETURNING id")).rows[0].id;
  const c=(await client.query("INSERT INTO whatsapp_conversations(assinatura_id,instance_key,owner_epoch,sender,reference,last_response_id,version) VALUES(41001,'upgrade-i01',$1,'5511999990001','0123456789abcdef',$2,1) RETURNING *",[epoch,delivery])).rows[0];
  await client.query('INSERT INTO whatsapp_conversation_responses(delivery_id,assinatura_id,conversation_id,owner_epoch,reference) VALUES($1,41001,$2,$3,$4)',[delivery,c.id,epoch,c.reference]);
  const event={instance:'upgrade-i01',phone:c.sender,messageId:'pending-original',text:'1',reference:null,timestamp:null,replyTo:null,quotedText:null,hasReplyContext:false};
  await client.query(`INSERT INTO whatsapp_conversation_inbox(instance_key,message_id,assinatura_id,owner_epoch,fingerprint,decision,sender,conversation_id,expected_version,expected_reference,expected_response_id,expected_step,pending_event,pending_at)
    VALUES('upgrade-i01',$1,41001,$2,$3,'awaiting_delivery',$4,$5,1,$6,$7,'MENU',$8::jsonb,clock_timestamp())`,[event.messageId,epoch,fingerprint(event),c.sender,c.id,c.reference,delivery,JSON.stringify(event)]);
  await client.query('COMMIT');
  const original=(await client.query('SELECT * FROM whatsapp_conversation_inbox')).rows;
  await t.test('022 rollback preserves existing draft, binding and pending input',async()=>{
    await client.query('BEGIN');await client.query(sql);await client.query('ROLLBACK');
    assert.equal((await client.query("SELECT to_regclass('whatsapp_conversation_captures') relation")).rows[0].relation,null);
    assert.deepEqual((await client.query('SELECT * FROM whatsapp_conversation_inbox')).rows,original);
  });
  await t.test('022 upgrade backfills only current question, preserving 021 data and checksums',async()=>{
    await Promise.all([migrate(pool),migrate(pool)]);await migrate(pool);
    const current=(await client.query('SELECT * FROM whatsapp_conversations')).rows[0],binding=(await client.query('SELECT * FROM whatsapp_conversation_responses')).rows[0];
    assert.equal(current.question_id,binding.question_id);assert.equal(current.version,c.version);assert.deepEqual(current.state,c.state);
    const pending=(await client.query('SELECT * FROM whatsapp_conversation_inbox')).rows[0];
    assert.equal(pending.capture_context,null);assert.equal(pending.captured_event,null);
    for(const [key,value] of Object.entries(original[0]))assert.deepEqual(pending[key],value);
    assert.equal((await client.query('SELECT count(*)::int n FROM whatsapp_conversation_captures')).rows[0].n,0);
  });
  await t.test('pre-022 pending is consumed once under its original strict correlation',async()=>{
    const db=require('../database');await db.ready;
    try {
      const p=require('../services/whatsapp/conversationStore').createConversationProcessor(db);await p.consumePending();await p.consumePending();
      const current=await db.getAsync('SELECT * FROM whatsapp_conversations WHERE id=$1',[c.id]);
      assert.equal(current.state.step,'SERVICE');assert.equal(current.version,2);
      assert.equal((await db.getAsync('SELECT decision FROM whatsapp_conversation_inbox WHERE message_id=$1',[event.messageId])).decision,'processed');
      assert.equal((await db.getAsync('SELECT count(*)::int n FROM agendamentos')).n,0);
    }finally{await db.close();}
  });
});
