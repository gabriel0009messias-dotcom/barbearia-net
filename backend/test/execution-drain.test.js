const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function child(body) {
  return new Promise((resolve, reject) => {
    const code = `const assert=require('node:assert/strict');
      const db=require('./database'),scope=require('./services/executionScope').executionScope;
      const lifecycle=require('./services/executionLifecycle');
      setTimeout(()=>console.error('DRAIN_DIAGNOSTIC '+JSON.stringify({scope:scope.snapshot(),resources:process.getActiveResourcesInfo()})),15000).unref();
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
      (async()=>{await db.ready;${body}})().catch(async e=>{console.error(e.stack);process.exitCode=1;await db.close();});`;
    const p = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = ''; p.stdout.on('data', c => { output += c; }); p.stderr.on('data', c => { errors += c; });
    const timer = setTimeout(() => { p.kill(); reject(Error('Child timeout: ' + output.slice(-2000) + errors.slice(-2000))); }, 30000);
    timer.unref();
    p.once('error', reject); p.once('exit', status => {
      clearTimeout(timer);
      if (status !== 0) return reject(Error('Child failed: ' + errors.slice(-6000)));
      const line = output.split(/\r?\n/).find(l => l.startsWith('DRAIN_REPORT '));
      resolve(line ? JSON.parse(line.slice(13)) : null);
    });
  });
}

test('3A startup, real ownership deadlines, transport and SQL drain', { timeout: 120000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment(), db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const tenant = async id => db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2,'ativo','2099-01-01')", [id, 'drain-' + id]);

  await t.test('real app persists startup identity before listeners and workers; restart and multiworker boots differ', async () => {
    const body = `
      process.env.PORT='0';
      const original=lifecycle.initializeExecutor;let initialized=false;
      lifecycle.initializeExecutor=async(...args)=>{
        const identity=await original(...args);
        const row=await db.getAsync('SELECT * FROM evolution_executors WHERE executor_id=$1',[identity.executorId]);
        assert.equal(row.boot_id,identity.bootId);assert.equal(row.deployment_id,null);
        assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_operation_executions WHERE executor_id=$1',[identity.executorId])).n,0);
        initialized=true;console.log('DRAIN_REPORT '+JSON.stringify(identity));return identity;
      };
      const webhook=require('./evolutionWebhook'),start=webhook.startWorker;
      webhook.startWorker=(...args)=>{assert.equal(initialized,true);return start(...args);};
      const log=console.log;console.log=(...args)=>{log(...args);if(String(args[0]).includes('Servidor rodando na porta')){assert.equal(initialized,true);process.emit('SIGTERM');}};
      require('./app');`;
    const [a, b] = await Promise.all([child(body), child(body)]), restart = await child(body);
    assert.notEqual(a.bootId, b.bootId); assert.notEqual(a.executorId, b.executorId);
    assert.notEqual(a.bootId, restart.bootId); assert.notEqual(a.executorId, restart.executorId);
  });

  await tenant(94001);
  await t.test('Promise.race timeout retains late provider callback, correlation, guard cleanup and reservation', async () => {
    await child(`
      await lifecycle.initializeExecutor(db.pool);
      const {randomUUID}=require('node:crypto'),late=deferred(),sql=deferred(),correlation=deferred();
      const row=await db.getAsync("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES(94001,'drain-94001','5511999990000',$1,'Synthetic','sending',$2,clock_timestamp()) RETURNING *",[randomUUID(),randomUUID()]);
      const delivery=require('./services/evolutionDelivery').createEvolutionDelivery(db,{timeoutMs:5000});let calls=0;
      await delivery.dispatch('whatsapp_messages',row,async()=>{
        calls++;await late.promise;
        await scope.follow('delivery.provider-correlation',async()=>{correlation.resolve();await sql.promise;await db.runAsync('SELECT 1');});
        return {key:{id:'accepted-late'},status:'PENDING'};
      });
      const before=await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[row.id]);
      const owner=await db.getAsync("SELECT * FROM evolution_instance_owners WHERE owner_id='94001'");
      assert.equal(before.status,'uncertain');assert.equal(calls,1);assert.ok(owner.operation_token);
      const timed=await scope.drain({timeoutMs:2});assert.deepEqual(timed,{drained:false,state:'DRAINING'});
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='ownership.callback'));
      await assert.rejects(delivery.dispatch('whatsapp_messages',row,()=>assert.fail()),{code:'INSTANCE_ADMISSION_CLOSED'});
      await assert.rejects(require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(db.pool).run(94001,()=>assert.fail()),{code:'INSTANCE_AUTHORIZATION_UNAVAILABLE'});
      late.resolve();await correlation.promise;
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='delivery.provider-correlation'));
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      sql.resolve();assert.equal((await scope.drain()).state,'CLOSED');
      assert.deepEqual(await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[row.id]),before);
      assert.deepEqual(await db.getAsync("SELECT * FROM evolution_instance_owners WHERE owner_id='94001'"),owner);
      assert.equal((await db.getAsync("SELECT count(*)::int n FROM evolution_operation_executions WHERE state='STOPPED'")).n,0);
      await db.close();`);
  });

  await tenant(94002);
  await t.test('HTTP body and SQL finalization remain active; queued HTTP cannot cross boundary during drain', async () => {
    await child(`
      await lifecycle.initializeExecutor(db.pool);
      process.env.EVOLUTION_API_URL='http://127.0.0.1:9';process.env.EVOLUTION_API_KEY='synthetic';
      const headers=deferred(),body=deferred(),finalize=deferred(),sqlEntered=deferred();let requests=0;
      globalThis.fetch=async()=>{requests++;headers.resolve();return {ok:true,status:200,text:()=>body.promise};};
      const op=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(db.pool);
      const flight=op.run(94002,()=>require('./evolutionApi').enviarTextoInstancia('drain-94002','5511999990000','Synthetic'),{timeoutMs:5000,onCompleted:async()=>{sqlEntered.resolve();await finalize.promise;}});
      await headers.promise;
      const queued=require('./evolutionApi').obterEstadoConexao('drain-94002');queued.catch(()=>{});
      scope.beginDrain();
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='evolution.http'));
      body.resolve(JSON.stringify({key:{id:'synthetic'},status:'PENDING'}));
      await sqlEntered.promise;
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='ownership.sql'));
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      finalize.resolve();await flight;await queued.catch(()=>{});await scope.drain();
      assert.equal(requests,1);
      assert.equal((await db.getAsync("SELECT count(*)::int n FROM evolution_operation_executions WHERE state='STOPPED'")).n,0);
      await db.close();`);
  });

  await tenant(94004);
  await t.test('drain during ownership lock wait prevents reservation and execution registration', async () => {
    await child(`
      await lifecycle.initializeExecutor(db.pool);
      const holder=await db.pool.connect();await holder.query('BEGIN');
      await holder.query('SELECT id FROM assinaturas WHERE id=94004 FOR UPDATE');
      const op=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(db.pool);
      const flight=op.run(94004,()=>assert.fail('no effect'));flight.catch(()=>{});
      await wait(30);scope.beginDrain();
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      await holder.query('ROLLBACK');holder.release();
      await assert.rejects(flight,{code:'INSTANCE_ADMISSION_CLOSED'});await scope.drain();
      assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_operation_executions WHERE assinatura_id=94004')).n,0);
      assert.equal((await db.getAsync("SELECT operation_token FROM evolution_instance_owners WHERE owner_id='94004'")).operation_token,null);
      await db.close();`);
  });

  await t.test('startup database failure closes local admission without fabricating durable evidence', async () => {
    await child(`
      await assert.rejects(lifecycle.initializeExecutor({connect:async()=>{throw Error('PostgreSQL unavailable');}}));
      require('./services/evolutionOwnershipOperation').stopExecutionAuthorization();
      assert.equal(scope.isOpen(),false);assert.equal((await scope.drain()).state,'CLOSED');
      await assert.rejects(scope.admit('work',()=>assert.fail()));
      assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_executors WHERE executor_id=$1',[lifecycle.processIdentity().executorId])).n,0);
      assert.equal((await db.getAsync("SELECT count(*)::int n FROM evolution_operation_executions WHERE state='STOPPED'")).n,0);
      await db.close();`);
  });

  await t.test('timed-out pool acquisition remains registered until the late connection is released', async () => {
    await child(`
      const connection=deferred();let releases=0;
      const op=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation({connect:()=>connection.promise});
      await assert.rejects(op.run(94003,()=>assert.fail()),{code:'INSTANCE_OPERATION_BUSY'});
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='ownership.connection'));
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      connection.resolve({release(){releases++;}});
      await scope.drain();assert.equal(releases,1);await db.close();`);
  });

  await t.test('diagnostic Promise.race retains both response reader and pending cancel', async () => {
    await child(`
      const read=deferred(),cancel=deferred();
      const response={status:429,headers:new Headers(),body:{getReader:()=>({read:()=>read.promise,cancel:()=>cancel.promise})}};
      await require('./evolutionDiagnostics').responseDiagnostic(response,{},Date.now());
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='evolution.diagnostic-read'));
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='evolution.diagnostic-cancel'));
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      read.resolve({done:true});await wait(5);
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      cancel.resolve();await scope.drain();await db.close();`);
  });

  await t.test('real outbox sendWithContext persists late correlation while its parent waits for children', async () => {
    await child(`
      process.env.EVOLUTION_WEBHOOK_SECRET='conversation-test-secret';
      const delivery=require('./services/evolutionDelivery'),original=delivery.createEvolutionDelivery;
      delivery.createEvolutionDelivery=(database,options)=>original(database,{...options,timeoutMs:5000});
      const f=await require('./test/helpers/conversation').fixture(db);
      await f.send('oi',{drain:false});
      const late=deferred(),sql=deferred(),sqlEntered=deferred();
      const runAsync=db.runAsync;
      db.runAsync=async(text,args)=>{
        if(text.startsWith('UPDATE whatsapp_conversation_responses SET provider_message_id')){sqlEntered.resolve();await sql.promise;}
        return runAsync(text,args);
      };
      await f.webhook.drain(async()=>{await late.promise;return {key:{id:'provider-late-real'},status:'PENDING'};});
      assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant])).status,'uncertain');
      scope.beginDrain();late.resolve();await sqlEntered.promise;
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='delivery.provider-correlation'));
      assert.ok(scope.snapshot().tasks.some(t=>t.kind==='outbox.drain'&&t.state==='WAITING_FOR_CHILDREN'));
      assert.equal((await scope.drain({timeoutMs:2})).drained,false);
      sql.resolve();await scope.drain();
      assert.equal((await db.getAsync('SELECT provider_message_id FROM whatsapp_conversation_responses WHERE assinatura_id=$1',[f.tenant])).provider_message_id,'provider-late-real');
      const row=await db.getAsync('SELECT * FROM whatsapp_messages WHERE assinatura_id=$1',[f.tenant]);
      assert.equal(row.status,'uncertain');assert.equal(row.attempts,1);assert.ok(row.operation_token);assert.equal(row.sent_at,null);
      await db.close();`);
  });
});
