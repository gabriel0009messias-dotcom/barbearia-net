const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');
const { checkAuthorization } = require('../services/executionLifecycle');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });

test('Stage 2: authorization is distinct from death, transport outcome and ownership', { timeout: 90000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment(), db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const q = (sql, args = []) => db.pool.query(sql, args);
  const op = createEvolutionOwnershipOperation(db.pool);
  let nextTenant = 92000;
  const tenant = async () => {
    const id = ++nextTenant;
    await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2,'ativo','2099-01-01')", [id,'lease-' + id]);
    return id;
  };
  const message = async () => {
    const id = await tenant();
    return (await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,clock_timestamp()) RETURNING *", [id,'lease-' + id,randomUUID(),randomUUID()])).rows[0];
  };
  const state = row => db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1', [row.id]);
  const owner = id => db.getAsync('SELECT * FROM evolution_instance_owners WHERE owner_id=$1', [String(id)]);
  const auth = id => db.getAsync('SELECT * FROM evolution_execution_authorizations WHERE execution_id=$1', [id]);
  const execution = row => db.getAsync('SELECT * FROM evolution_operation_executions WHERE delivery_id=$1 AND assinatura_id=$2', [row.id,row.assinatura_id]);
  // Only this isolated test schema has an accelerated PostgreSQL lease clock.
  const duration = ms => q("CREATE OR REPLACE FUNCTION studiofy_execution_lease_duration() RETURNS interval LANGUAGE sql IMMUTABLE AS $$ SELECT interval '" + ms + " milliseconds' $$");
  const probe = async (context, binding = null, options = {}) => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM assinaturas WHERE id=$1 FOR UPDATE', [context.assinaturaId]);
      await c.query('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1 FOR UPDATE', [String(context.assinaturaId)]);
      const result = await checkAuthorization(c, env.schema, context, binding, options);
      await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  };

  await t.test('new registration creates authorization atomically; PostgreSQL supplies all lease timestamps', async () => {
    await op.run(await tenant(), async context => {
      const a = await auth(context.executionId);
      assert.equal(a.state,'ACTIVE'); assert.equal(a.revoked_at,null);
      assert.equal(a.lease_until - a.heartbeat_at,15000);
      assert.equal(a.updated_at.getTime(),a.heartbeat_at.getTime());
      const now = (await q('SELECT clock_timestamp() AS now')).rows[0].now;
      assert.ok(a.heartbeat_at <= now && a.lease_until > now);
      await context.authorizeEffect();
    });
  });

  await t.test('heartbeat renews only the exact executor/execution/boot/token/tenant/instance', async () => {
    await op.run(await tenant(), async context => {
      const before = await auth(context.executionId); await wait(20);
      for (const mutation of [
        { executionId: randomUUID() }, { executorId: randomUUID() }, { bootId: randomUUID() },
        { operationToken: randomUUID() }, { assinaturaId: context.assinaturaId + 1 }, { instanceName: 'wrong-instance' },
      ]) {
        assert.equal(await probe({ ...context,...mutation },null,{ renew:true }),false);
        assert.deepEqual(await auth(context.executionId),before);
      }
      assert.equal(await probe(context,null,{ renew:true }),true);
      assert.ok((await auth(context.executionId)).lease_until > before.lease_until);
    });
  });

  await t.test('a second valid execution cannot renew another execution by swapping its ID', async () => {
    await op.run(await tenant(), async a => op.run(await tenant(), async b => {
      assert.equal(await probe({ ...a, executionId:b.executionId },null,{ renew:true }),false);
      assert.equal(await probe({ ...b, executionId:a.executionId },null,{ renew:true }),false);
    }));
  });

  await t.test('delivery, kind and claim are required for both heartbeat and effect authorization', async () => {
    const row = await message();
    await op.run(row.assinatura_id, async context => {
      const correct = { kind:'whatsapp_messages',id:row.id,claimToken:row.claim_token };
      assert.equal(await probe(context,correct,{ renew:true }),true);
      for (const binding of [null,{ ...correct,id:row.id+99999 },{ ...correct,claimToken:randomUUID() },{ ...correct,kind:'appointment_reminders' }])
        assert.equal(await probe(context,binding,{ renew:true }),false);
    }, { delivery:{ kind:'whatsapp_messages',id:row.id,claimToken:row.claim_token },
      onReserved:(c,ctx) => c.query('UPDATE whatsapp_messages SET operation_token=$1 WHERE id=$2',[ctx.operationToken,row.id]) });
  });

  await t.test('real timer renews a live execution without changing its immutable evidence', async () => {
    const id = await tenant();
    await op.run(id, async context => {
      const before = await auth(context.executionId);
      await wait(3250);
      assert.ok((await auth(context.executionId)).heartbeat_at > before.heartbeat_at);
      assert.equal((await db.getAsync('SELECT state,heartbeat_at,lease_until,stopped_at FROM evolution_operation_executions WHERE execution_id=$1',[context.executionId])).stopped_at,null);
      await context.authorizeEffect();
    });
  });

  await t.test('expired authorization becomes UNKNOWN, never resurrects, never proves STOPPED or frees ownership', async () => {
    await duration(180); const id = await tenant(); let captured;
    await assert.rejects(op.run(id,async context => {
      captured = context; await wait(240);
      const view = await db.getAsync('SELECT authorization_state FROM evolution_execution_authorization_status WHERE execution_id=$1',[context.executionId]);
      assert.equal(view.authorization_state,'UNKNOWN');
      assert.equal(await probe(context,null,{ renew:true }),false);
      assert.equal((await auth(context.executionId)).state,'UNKNOWN');
      await context.authorizeEffect();
    }));
    const reserved = await owner(id); assert.equal(reserved.operation_token,captured.operationToken);
    const a = await auth(captured.executionId); assert.equal(a.state,'UNKNOWN'); assert.ok(a.revoked_at);
    assert.equal(await probe(captured,null,{ renew:true }),false);
    await assert.rejects(q("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[captured.executionId]),e=>e.code==='23514');
    const e = await db.getAsync('SELECT * FROM evolution_operation_executions WHERE execution_id=$1',[captured.executionId]);
    assert.equal(e.state,'ACTIVE'); assert.equal(e.stopped_at,null);
    await assert.rejects(op.run(id,()=>assert.fail('no new reservation')),{code:'INSTANCE_OPERATION_BUSY'});
    await duration(15000);
  });

  await t.test('expiry before frontier blocks transport, keeps fence, no attempts, no retry or reconciliation', async () => {
    await duration(180); const row = await message(); let calls = 0;
    const delivery = createEvolutionDelivery(db);
    await delivery.dispatch('whatsapp_messages',row,async()=>{ calls++; return accepted(); },{ validate:async()=>{ await wait(240); return true; } });
    const before = await state(row), e = await execution(row);
    assert.equal(calls,0); assert.equal(before.status,'uncertain'); assert.equal(before.attempts,0);
    assert.equal(before.dispatch_started_at,null); assert.equal(before.sent_at,null);
    assert.equal((await auth(e.execution_id)).state,'UNKNOWN'); assert.equal(e.stopped_at,null);
    assert.equal((await owner(row.assinatura_id)).operation_token,before.operation_token);
    await delivery.recoverInterrupted('whatsapp_messages',new Date(Date.now()+120000));
    await delivery.dispatch('whatsapp_messages',before,()=>assert.fail('uncertain must never retry'));
    assert.deepEqual(await state(row),before);
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n,0);
    await duration(15000);
  });

  await t.test('expiry during frontier lock wait fails inside the delivery transaction', async () => {
    await duration(350); const row = await message(); let calls = 0, captured;
    const wrapped = { ...db,runAsync:async(sql,args)=>{
      if(sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1')) {
        captured = await execution(row);
        const lock = await db.pool.connect();
        try {
          await lock.query('BEGIN'); await lock.query('SELECT execution_id FROM evolution_execution_authorizations WHERE execution_id=$1 FOR UPDATE',[captured.execution_id]);
          const pending = db.runAsync(sql,args); pending.catch(()=>{});
          await wait(450); await lock.query('COMMIT'); return await pending;
        } finally { lock.release(); }
      }
      return db.runAsync(sql,args);
    } };
    await createEvolutionDelivery(wrapped).dispatch('whatsapp_messages',row,async()=>{calls++;return accepted();});
    assert.equal(calls,0); assert.equal((await state(row)).dispatch_started_at,null);
    assert.equal((await owner(row.assinatura_id)).operation_token,captured.operation_token);
    await duration(15000);
  });

  await t.test('PostgreSQL failure during pre-boundary validation fails closed', async () => {
    const row = await message(); let unavailable = false,calls = 0;
    const pool = { options:db.pool.options,connect:async()=>{ if(unavailable)throw Error('Synthetic PostgreSQL unavailable'); return db.pool.connect(); } };
    await createEvolutionDelivery({ ...db,pool }).dispatch('whatsapp_messages',row,async()=>{calls++;return accepted();},{ validate:async()=>{unavailable=true;return true;} });
    assert.equal(calls,0); const after = await state(row);
    assert.equal(after.status,'uncertain'); assert.equal(after.attempts,0); assert.equal(after.dispatch_started_at,null);
    assert.equal((await owner(row.assinatura_id)).operation_token,after.operation_token);
  });

  await t.test('lost authorization COMMIT acknowledgement never authorizes transport', async () => {
    const row = await message(); let commits = 0,calls = 0;
    const pool = {options:db.pool.options,connect:async()=>{
      const c=await db.pool.connect();return {on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),query:async cfg=>{
        const result=await c.query(cfg);if(cfg.text==='COMMIT'&&++commits===2)throw Error('Synthetic lost authorization ACK');return result;
      }};
    }};
    await createEvolutionDelivery({...db,pool}).dispatch('whatsapp_messages',row,async()=>{calls++;return accepted();});
    assert.equal(calls,0);assert.equal((await state(row)).status,'uncertain');
    assert.ok((await owner(row.assinatura_id)).operation_token);
  });

  await t.test('expiry after boundary neither aborts HTTP nor grants late callback fresh authority', async () => {
    await duration(180); const row = await message(); let calls=0;
    await createEvolutionDelivery(db).dispatch('whatsapp_messages',row,async()=>{
      calls++; const {assertEvolutionOperation}=require('../services/evolutionOwnershipOperation');
      const context=assertEvolutionOperation(row.instance);await wait(240);
      assert.equal(context.signal.aborted,false,'lease expiry is not cancellation of an authorized call');
      await assert.rejects(context.authorizeEffect());
      assert.equal(context.signal.aborted,false);
      return accepted();
    });
    const before=await state(row);assert.equal(calls,1);assert.equal(before.status,'uncertain');assert.equal(before.attempts,1);assert.equal(before.sent_at,null);
    assert.ok((await owner(row.assinatura_id)).operation_token);
    await duration(15000);
  });

  await t.test('provider response already in flight can finalize normally after lease time passes', async () => {
    await duration(180);const row=await message();let calls=0;
    await createEvolutionDelivery(db).dispatch('whatsapp_messages',row,async()=>{calls++;await wait(240);return accepted();});
    assert.equal(calls,1);assert.equal((await state(row)).status,'sent');assert.equal((await owner(row.assinatura_id)).operation_token,null);
    await duration(15000);
  });

  await t.test('serialized HTTP revalidates lease immediately before fetch', async () => {
    await duration(180);const row=await message();let fetches=0;
    const api=require('../evolutionApi'),guard=require('../evolutionConnectionGuard');
    process.env.EVOLUTION_API_URL='http://127.0.0.1:55599';process.env.EVOLUTION_API_KEY='synthetic-local-only';
    const original=global.fetch;global.fetch=async()=>{fetches++;return new Response(JSON.stringify(accepted()),{status:200});};
    let release;const held=guard.serialize('http://127.0.0.1:55599|'+row.instance,()=>new Promise(resolve=>{release=resolve;}));
    await wait(10);
    try {
      assert.equal(typeof api.enviarTextoInstancia,'function');
      const work=createEvolutionDelivery(db).dispatch('whatsapp_messages',row,api.enviarTextoInstancia);
      await wait(260);assert.ok((await state(row)).dispatch_started_at);release();await held;await work;
      assert.equal(fetches,0);assert.equal((await state(row)).status,'uncertain');
    } finally {global.fetch=original;process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';await duration(15000);}
  });

  await t.test('concurrent workers remain exclusive and concurrent heartbeats cannot steal identity', async () => {
    const id=await tenant();let entered,resume;const ready=new Promise(r=>{entered=r;}),done=new Promise(r=>{resume=r;});
    const work=op.run(id,async context=>{entered(context);await done;});const context=await ready;
    try {
      await assert.rejects(op.run(id,()=>assert.fail()),{code:'INSTANCE_OPERATION_BUSY'});
      assert.deepEqual(await Promise.all([probe(context,null,{renew:true}),probe(context,null,{renew:true})]),[true,true]);
    } finally {resume();await work;}
  });

  await t.test('a completed context cannot authorize new effects or renew a released reservation', async () => {
    let context;await op.run(await tenant(),async c=>{context=c;});
    await assert.rejects(context.authorizeEffect());assert.equal(await probe(context,null,{renew:true}),false);
  });

  await t.test('heartbeat database failure revokes local authority even before the persisted lease deadline',async()=>{
    const id=await tenant();let captured;
    const pool={connect:async()=>{const c=await db.pool.connect();return {
      on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a),release:(...a)=>c.release(...a),
      query:async cfg=>{if(cfg.text.includes("SET state='ACTIVE' WHERE execution_id="))throw Error('Synthetic heartbeat write failure');return c.query(cfg);},
    };}};
    await assert.rejects(createEvolutionOwnershipOperation(pool).run(id,async context=>{
      captured=context;await wait(3250);
      await assert.rejects(context.authorizeEffect());
    }));
    assert.equal((await auth(captured.executionId)).state,'UNKNOWN');
    assert.equal((await owner(id)).operation_token,captured.operationToken);
  });

  await t.test('local clock cannot extend or shorten PostgreSQL authorization',async sub=>{
    await op.run(await tenant(),async context=>{
      const original=Date.now;
      try {
        Date.now=()=>original()+864000000;
        assert.equal(await probe(context,null,{renew:true}),true);
        const a=await auth(context.executionId),now=(await q('SELECT clock_timestamp() AS now')).rows[0].now;
        assert.ok(a.lease_until-now<=15000&&a.lease_until>now);
        Date.now=()=>0;await context.authorizeEffect();
      } finally {Date.now=original;}
    });
  });

  await t.test('authorization insert failure rolls back executor/execution/reservation and prevents transport',async()=>{
    const row=await message();
    await q("CREATE FUNCTION stage2_fail_authorization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic authorization registration failure'; END $$");
    await q('CREATE TRIGGER stage2_fail_authorization BEFORE INSERT ON evolution_execution_authorizations FOR EACH ROW EXECUTE FUNCTION stage2_fail_authorization()');
    try {
      await createEvolutionDelivery(db).dispatch('whatsapp_messages',row,()=>assert.fail('no transport'));
      assert.equal(await execution(row),undefined);assert.equal((await owner(row.assinatura_id)).operation_token,null);
      assert.equal((await state(row)).attempts,0);
    } finally {await q('DROP TRIGGER stage2_fail_authorization ON evolution_execution_authorizations');await q('DROP FUNCTION stage2_fail_authorization()');}
  });

  await t.test('valid authorization reaches HTTP exactly once through the real adapter',async()=>{
    const row=await message(),api=require('../evolutionApi');let calls=0;
    process.env.EVOLUTION_API_URL='http://127.0.0.1:55599';process.env.EVOLUTION_API_KEY='synthetic-local-only';
    const original=global.fetch;global.fetch=async()=>{calls++;return new Response(JSON.stringify(accepted()),{status:200});};
    try {
      await createEvolutionDelivery(db).dispatch('whatsapp_messages',row,api.enviarTextoInstancia);
      assert.equal(calls,1);assert.equal((await state(row)).status,'sent');
    } finally {global.fetch=original;process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';}
  });

  await t.test('PostgreSQL loss after intent still prevents the actual HTTP fetch',async()=>{
    const row=await message(),api=require('../evolutionApi');let unavailable=false,calls=0;
    const pool={options:db.pool.options,connect:async()=>{if(unavailable)throw Error('Synthetic PostgreSQL loss');return db.pool.connect();}};
    const wrapped={...db,pool,runAsync:async(sql,args)=>{const result=await db.runAsync(sql,args);if(sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1'))unavailable=true;return result;}};
    process.env.EVOLUTION_API_URL='http://127.0.0.1:55599';process.env.EVOLUTION_API_KEY='synthetic-local-only';
    const original=global.fetch;global.fetch=async()=>{calls++;return new Response(JSON.stringify(accepted()),{status:200});};
    try {
      await createEvolutionDelivery(wrapped).dispatch('whatsapp_messages',row,api.enviarTextoInstancia);
      const after=await state(row);assert.equal(calls,0);assert.equal(after.status,'uncertain');assert.equal(after.attempts,1);assert.ok(after.dispatch_started_at);assert.ok((await owner(row.assinatura_id)).operation_token);
    } finally {global.fetch=original;process.env.EVOLUTION_API_URL='';process.env.EVOLUTION_API_KEY='';}
  });

  await t.test('expiry observed by heartbeat does not abort an in-flight HTTP operation',async()=>{
    await duration(180);const row=await message();let calls=0;
    await createEvolutionDelivery(db).dispatch('whatsapp_messages',row,async()=>{
      calls++;const context=require('../services/evolutionOwnershipOperation').assertEvolutionOperation(row.instance);
      await wait(3250);assert.equal(context.signal.aborted,false);
      assert.equal((await auth(context.executionId)).state,'UNKNOWN');
      return accepted();
    });
    assert.equal(calls,1);assert.equal((await state(row)).status,'uncertain');assert.ok((await owner(row.assinatura_id)).operation_token);
    await duration(15000);
  });

  await t.test('shutdown rejects new effects and reservations without STOPPED or releasing an active reservation',async()=>{
    const id=await tenant();let context;
    await assert.rejects(op.run(id,async c=>{
      context=c;require('../services/evolutionOwnershipOperation').stopExecutionAuthorization();
      await assert.rejects(c.authorizeEffect());
      await assert.rejects(op.run(id,()=>assert.fail()),{code:'INSTANCE_AUTHORIZATION_UNAVAILABLE'});
    }));
    assert.equal((await owner(id)).operation_token,context.operationToken);
    assert.equal((await auth(context.executionId)).state,'UNKNOWN');
    assert.equal((await db.getAsync('SELECT stopped_at FROM evolution_operation_executions WHERE execution_id=$1',[context.executionId])).stopped_at,null);
  });
});
