const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');
const { processIdentity } = require('../services/executionLifecycle');

const accepted = () => ({ key: { id: randomUUID() }, status: 'PENDING' });

test('execution lifecycle Stage 1: durable identity without new recovery semantics', { timeout: 120000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const op = createEvolutionOwnershipOperation(db.pool);
  const q = (sql, args = []) => db.pool.query(sql, args);
  for (const tenant of [90001, 90002, 90003, 90004, 90005, 90006]) {
    await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session,status,proximo_vencimento) VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2,'ativo','2099-01-01')", [tenant, 'lifecycle-' + tenant]);
  }
  const message = (tenant = 90001) => db.getAsync("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,clock_timestamp()) RETURNING *", [tenant,'lifecycle-' + tenant,randomUUID(),randomUUID()]);
  const state = id => db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1', [id]);
  const owner = tenant => db.getAsync("SELECT * FROM evolution_instance_owners WHERE model='principal' AND source_schema=$1 AND owner_id=$2", [env.schema,String(tenant)]);
  const execution = id => db.getAsync('SELECT * FROM evolution_operation_executions WHERE delivery_id=$1', [id]);

  await t.test('generic operation atomically registers its real executor and reservation', async () => {
    await op.run(90001, async context => {
      const e = await db.getAsync('SELECT * FROM evolution_operation_executions WHERE execution_id=$1', [context.executionId]);
      assert.equal(e.executor_id, processIdentity().executorId);
      assert.equal(e.operation_token, context.operationToken);
      assert.equal(e.operation_kind, 'instance_operation'); assert.equal(e.delivery_id, null);
      assert.equal((await owner(90001)).operation_token, e.operation_token);
      const p = await db.getAsync('SELECT * FROM evolution_executors WHERE executor_id=$1', [e.executor_id]);
      assert.equal(p.boot_id, context.bootId); assert.equal(p.process_id, process.pid);
      assert.equal(p.started_at.toISOString(), processIdentity().startedAt);
      assert.equal(e.state, 'ACTIVE'); assert.equal(e.heartbeat_at, null); assert.equal(e.lease_until, null);
    });
    assert.equal((await owner(90001)).operation_token, null); // Existing success behavior.
  });

  let successful;
  await t.test('delivery evidence commits with the exact claim before transport boundary', async () => {
    successful = await message(); let calls = 0;
    await createEvolutionDelivery(db).dispatch('whatsapp_messages', successful, async (instance, phone, response) => {
      calls++;
      const e = await execution(successful.id), row = await state(successful.id);
      assert.equal(e.operation_kind, 'whatsapp_messages'); assert.equal(e.delivery_id, row.id);
      assert.equal(e.assinatura_id, row.assinatura_id); assert.equal(e.instance_name, instance);
      assert.equal(e.claim_token, row.claim_token); assert.equal(e.operation_token, row.operation_token);
      assert.equal((await owner(row.assinatura_id)).operation_token, e.operation_token);
      assert.ok(e.started_at <= row.dispatch_started_at);
      assert.equal(row.attempts, 1); assert.equal(phone, row.phone); assert.equal(response, row.response);
      assert.equal(e.state, 'ACTIVE'); assert.equal(e.stopped_at, null);
      return accepted();
    });
    assert.equal(calls, 1); assert.equal((await state(successful.id)).status, 'sent');
    assert.equal((await execution(successful.id)).state, 'ACTIVE'); // No STOPPED inference in Stage 1.
  });

  await t.test('concurrent operations in one process share only its executor, not execution or token', async () => {
    const rows = await Promise.all([message(90001), message(90002)]);
    let entered = 0, resume; const both = new Promise(resolve => { resume = resolve; });
    await Promise.all(rows.map(row => createEvolutionDelivery(db).dispatch('whatsapp_messages', row, async () => {
      if (++entered === 2) resume(); await both; return accepted();
    })));
    assert.equal(entered, 2);
    const [a,b] = await Promise.all(rows.map(row => execution(row.id)));
    assert.equal(a.executor_id, b.executor_id); assert.equal(a.executor_id, processIdentity().executorId);
    assert.notEqual(a.execution_id, b.execution_id); assert.notEqual(a.operation_token, b.operation_token);
    assert.notEqual(a.assinatura_id, b.assinatura_id);
  });

  await t.test('identity, state and reserved lease fields cannot be rewritten or removed', async () => {
    const e = await execution(successful.id);
    for (const expression of [
      'execution_id=gen_random_uuid()', 'executor_id=gen_random_uuid()', 'operation_token=gen_random_uuid()',
      'assinatura_id=90002', "instance_name='other'", "operation_kind='instance_operation'", 'delivery_id=999',
      'claim_token=gen_random_uuid()', "started_at=started_at+interval '1 second'", "state='UNKNOWN'",
      "state='STOPPED',stopped_at=clock_timestamp()", 'heartbeat_at=clock_timestamp()', 'lease_until=clock_timestamp()',
    ]) await assert.rejects(q('UPDATE evolution_operation_executions SET ' + expression + ' WHERE execution_id=$1', [e.execution_id]), error => error.code === '23514');
    for (const expression of ['executor_id=gen_random_uuid()', 'boot_id=gen_random_uuid()', 'process_id=1',
      "started_at=started_at+interval '1 second'", "service_id='other'", "deployment_id='other'", "instance_id='other'", "revision='other'"])
      await assert.rejects(q('UPDATE evolution_executors SET ' + expression + ' WHERE executor_id=$1', [e.executor_id]), error => error.code === '23514');
    await assert.rejects(q('DELETE FROM evolution_operation_executions WHERE execution_id=$1', [e.execution_id]), error => error.code === '23514');
    await assert.rejects(q('TRUNCATE evolution_operation_executions'), error => ['23514','0A000'].includes(error.code));
    await assert.rejects(q('TRUNCATE evolution_operation_executions CASCADE'), error => error.code === '23514');
    await assert.rejects(q('DELETE FROM evolution_executors WHERE executor_id=$1', [e.executor_id]));
    assert.deepEqual(await execution(successful.id), e);
  });

  await t.test('registration failure rolls back reservation and binding before transport', async () => {
    const row = await message();
    await q("CREATE FUNCTION stage1_fail_registration() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic registration failure'; END $$");
    await q('CREATE TRIGGER stage1_fail_registration BEFORE INSERT ON evolution_operation_executions FOR EACH ROW EXECUTE FUNCTION stage1_fail_registration()');
    try {
      await createEvolutionDelivery(db).dispatch('whatsapp_messages', row, () => assert.fail('no transport'));
      assert.equal(await execution(row.id), undefined); assert.equal((await owner(row.assinatura_id)).operation_token, null);
      const after = await state(row.id); assert.equal(after.status, 'pending'); assert.equal(after.attempts, 0);
      assert.equal(after.operation_token, null); assert.equal(after.dispatch_started_at, null);
    } finally {
      await q('DROP TRIGGER stage1_fail_registration ON evolution_operation_executions');
      await q('DROP FUNCTION stage1_fail_registration()');
    }
  });

  await t.test('wrong delivery, tenant, instance and claim cannot be attached to a reservation', async () => {
    const row = await message();
    const cases = [
      { tenant: 90001, id: row.id + 99999, claim: row.claim_token },
      { tenant: 90002, id: row.id, claim: row.claim_token },
      { tenant: 90001, id: row.id, claim: randomUUID() },
    ];
    for (const item of cases) {
      await assert.rejects(op.run(item.tenant, () => assert.fail('no callback'), {
        delivery: { kind: 'whatsapp_messages', id: item.id, claimToken: item.claim },
        onReserved: (client, ctx) => client.query('UPDATE whatsapp_messages SET operation_token=$1 WHERE id=$2', [ctx.operationToken,row.id]),
      }));
      assert.equal((await owner(item.tenant)).operation_token, null);
      assert.equal((await state(row.id)).operation_token, null);
    }
    await assert.rejects(op.run(90001, () => assert.fail(), { expectedInstance: 'lifecycle-90002' }));
    assert.equal(await execution(row.id), undefined);
  });

  await t.test('timeout and late callback never infer STOPPED, release or retry uncertain', async () => {
    const row = await message(90003); let finish, calls = 0;
    await createEvolutionDelivery(db, { timeoutMs: 1000 }).dispatch('whatsapp_messages', row, async () => {
      calls++; return new Promise(resolve => { finish = resolve; });
    });
    assert.equal(calls, 1); const before = await state(row.id), reserved = await owner(row.assinatura_id);
    assert.equal(before.status, 'uncertain'); assert.equal(before.attempts, 1); assert.equal(before.sent_at, null);
    assert.equal((await execution(row.id)).state, 'ACTIVE');
    finish(accepted()); await new Promise(resolve => setTimeout(resolve, 30));
    const delivery = createEvolutionDelivery(db);
    await delivery.recoverInterrupted('whatsapp_messages');
    await delivery.dispatch('whatsapp_messages', before, () => assert.fail('uncertain cannot retry'));
    assert.deepEqual(await state(row.id), before); assert.deepEqual(await owner(row.assinatura_id), reserved);
    const e = await execution(row.id);
    assert.equal(e.state, 'ACTIVE'); assert.equal(e.stopped_at, null); assert.equal(e.lease_until, null);
    await assert.rejects(op.run(row.assinatura_id, () => assert.fail()), { code: 'INSTANCE_OPERATION_BUSY' });
    assert.equal((await db.getAsync('SELECT count(*)::int n FROM evolution_delivery_reconciliations')).n, 0);
  });

  const child = tenant => new Promise((resolve,reject) => {
    const code = "const db=require('./database'); db.ready.then(()=>require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(db.pool).run(Number(process.argv[1]),async c=>{console.log('STAGE1_IDENTITY '+JSON.stringify(require('./services/executionLifecycle').processIdentity()))})).then(()=>db.close()).catch(()=>{process.exitCode=1;db.close()});";
    const processChild = spawn(process.execPath, ['-e',code,String(tenant)], { cwd: path.join(__dirname,'..'), env: {
      ...process.env, RENDER_SERVICE_ID: 'synthetic-service', RENDER_DEPLOY_ID: 'synthetic-deployment', RENDER_INSTANCE_ID: 'synthetic-runtime', RENDER_GIT_COMMIT: 'synthetic-revision',
    }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let output = ''; processChild.stdout.on('data', chunk => { output += chunk; });
    processChild.stderr.resume(); processChild.on('error',reject);
    processChild.on('exit', status => { try {
      assert.equal(status,0); const line = output.split(/\r?\n/).find(line => line.startsWith('STAGE1_IDENTITY '));
      resolve(JSON.parse(line.slice('STAGE1_IDENTITY '.length)));
    } catch(error) { reject(error); } });
  });
  await t.test('separate workers and restart create distinct durable boot and executor identities', async () => {
    const [a,b] = await Promise.all([child(90004),child(90005)]), restarted = await child(90004);
    assert.notEqual(a.executorId,b.executorId); assert.notEqual(a.bootId,b.bootId);
    assert.notEqual(a.executorId,restarted.executorId); assert.notEqual(a.bootId,restarted.bootId);
    for (const p of [a,b,restarted]) {
      assert.notEqual(p.executorId,processIdentity().executorId);
      const stored = await db.getAsync('SELECT * FROM evolution_executors WHERE executor_id=$1', [p.executorId]);
      assert.equal(stored.boot_id,p.bootId); assert.equal(stored.process_id,p.processId);
      assert.equal(stored.service_id,'synthetic-service'); assert.equal(stored.deployment_id,'synthetic-deployment');
      assert.equal(stored.instance_id,'synthetic-runtime'); assert.equal(stored.revision,'synthetic-revision');
    }
    const before = processIdentity(); delete require.cache[require.resolve('../services/executionLifecycle')];
    assert.strictEqual(require('../services/executionLifecycle').processIdentity(),before);
  });

  await t.test('lost registration COMMIT acknowledgement never starts work or loses provenance', async () => {
    let lost = false;
    const pool = { connect: async () => {
      const c = await db.pool.connect(); return {
        on: (...a) => c.on(...a), removeListener: (...a) => c.removeListener(...a), release: (...a) => c.release(...a),
        query: async cfg => { const result = await c.query(cfg); if (cfg.text === 'COMMIT' && !lost) { lost = true; throw Error('Synthetic lost COMMIT ACK'); } return result; },
      };
    } };
    await assert.rejects(createEvolutionOwnershipOperation(pool).run(90006, () => assert.fail('no callback without COMMIT ACK')));
    const reserved = await owner(90006); assert.ok(reserved.operation_token);
    const e = await db.getAsync('SELECT * FROM evolution_operation_executions WHERE operation_token=$1', [reserved.operation_token]);
    assert.equal(e.assinatura_id,90006); assert.equal(e.state,'ACTIVE');
  });

  await t.test('synthetic legacy delivery 37 and its fence remain byte-for-byte unchanged and untracked', async () => {
    const tenant = 91006, token = randomUUID(), claim = randomUUID();
    await db.runAsync("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES($1,'Legacy fixture','Synthetic','11999990000','mercado_pago',5,'','legacy-stage1')", [tenant]);
    await db.runAsync("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,dispatch_started_at,attempts) VALUES(37,$1,'legacy-stage1','5511999990000',$2,'Synthetic legacy','uncertain',$3,$4,clock_timestamp(),1)", [tenant,randomUUID(),claim,token]);
    await db.runAsync('UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2', [token,String(tenant)]);
    const before = await state(37), reserved = await owner(tenant), delivery = createEvolutionDelivery(db);
    await delivery.recoverInterrupted('whatsapp_messages');
    await delivery.dispatch('whatsapp_messages', before, () => assert.fail('legacy never sends'));
    assert.deepEqual(await state(37),before); assert.deepEqual(await owner(tenant),reserved);
    assert.equal(await execution(37),undefined);
    await assert.rejects(op.run(tenant, () => assert.fail()), { code: 'INSTANCE_OPERATION_BUSY' });
    assert.equal(await execution(37),undefined);
  });
});
