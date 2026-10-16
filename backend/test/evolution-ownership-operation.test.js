const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createEvolutionOwnershipOperation } = require('../services/evolutionOwnershipOperation');

test('Evolution ownership operation: durable fencing, deadlines and explicit reconciliation without transport', { timeout: 60000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const alternative = 'test_' + randomUUID().replaceAll('-', '');
  process.env.LEGACY_DATABASE_SCHEMA = alternative;
  const db = require('../database'); await db.ready;
  const pool = new Pool(require('../database/config').connectionConfig());
  t.after(async () => { await pool.query('DROP SCHEMA IF EXISTS "' + alternative + '" CASCADE'); await require('../src/database/pool').pool.end(); await pool.end(); await db.close(); await env.cleanup(); });
  const s = '"' + env.schema + '"', operation = createEvolutionOwnershipOperation(pool, { schema: env.schema });
  const assign = (id, name) => pool.query('UPDATE ' + s + '.assinaturas SET whatsapp_session=$2 WHERE id=$1', [id, name]);
  const record = async id => (await pool.query('SELECT * FROM ' + s + '.evolution_instance_owners WHERE owner_id=$1', [String(id)])).rows[0];
  for (const id of [806, 807]) await db.runAsync("INSERT INTO assinaturas (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES ($1,'Synthetic operation','Owner','11999990000','mercado_pago',5,'',$2)", [id, 'operation-test-' + id]);
  await require('../src/database/migrate').runMigrations({ targetPool: pool, mainSchema: env.schema, legacySchema: alternative });
  const salon = randomUUID();
  await pool.query('INSERT INTO "' + alternative + '".salons (id,name,slug,owner_name,email) VALUES ($1,$2,$3,$4,$5)', [salon, 'Synthetic alternate', salon, 'Owner', salon + '@example.test']);
  await pool.query('INSERT INTO "' + alternative + '".whatsapp_sessions (salon_id) VALUES ($1)', [salon]);
  let network = 0; t.mock.method(global, 'fetch', async () => { network++; throw Error('No transport permitted'); });
  await t.test('invalid identities, operation and arbitrary expected instances never invoke the callback', async () => {
    let calls = 0; const callback = () => { calls++; };
    for (const tenant of ['806', 0, -1, {}, 1.5]) await assert.rejects(operation.run(tenant, callback), { code: 'INSTANCE_INVALID_TENANT' });
    for (const timeoutMs of [0, -1, 15001, 1.5]) await assert.rejects(operation.run(806, callback, { timeoutMs }), { code: 'INSTANCE_INVALID_OPERATION' });
    await assert.rejects(operation.run(806, callback, { expectedInstance: 'operation-test-807' }), { code: 'INSTANCE_OWNER_MISMATCH' });
    assert.equal(calls, 0);
  });
  await t.test('valid owner is fenced before callback, unrelated tenant remains usable, success releases', async () => {
    const result = await operation.run(806, async context => {
      assert.equal(context.instanceName, 'operation-test-806'); assert.equal(context.assinaturaId, 806); context.assertActive();
      assert.equal((await record(806)).operation_token, context.operationToken);
      await operation.run(807, async other => assert.equal(other.instanceName, 'operation-test-807'));
      const start = Date.now();
      await assert.rejects(assign(806, 'must-not-switch-test'), error => error.code === '23514');
      assert.ok(Date.now() - start < 1500, 'Association change fails instead of waiting for a long SQL lock');
      await assert.rejects(operation.run(806, () => assert.fail('busy callback')), { code: 'INSTANCE_OPERATION_BUSY' });
      await assert.rejects(pool.query('DELETE FROM ' + s + '.assinaturas WHERE id=806'), error => error.code === '23514');
      await assert.rejects(pool.query('DELETE FROM ' + s + '.evolution_instance_owners WHERE owner_id=$1', ['806']), error => error.code === '23514');
      await assert.rejects(pool.query('UPDATE ' + s + '.evolution_instance_owners SET instance_name=$1 WHERE owner_id=$2', ['changed-test', '806']), error => error.code === '23514');
      await assert.rejects(pool.query('UPDATE ' + s + '.evolution_instance_owners SET operation_token=$1 WHERE owner_id=$2', [randomUUID(), '806']), error => error.code === '23514');
      await assert.rejects(pool.query('TRUNCATE ' + s + '.assinaturas CASCADE'), error => error.code === '23514');
      await pool.query('UPDATE ' + s + '.assinaturas SET whatsapp_status=$1 WHERE id=806', ['conectado']);
      return 'completed locally';
    });
    assert.equal(result, 'completed locally'); assert.equal((await record(806)).operation_token, null);
    await assign(806, 'operation-test-new'); await assign(806, 'operation-test-806');
  });
  await t.test('independent guard processes cannot reserve a busy instance', async () => {
    let enter, finish; const entered = new Promise(resolve => { enter = resolve; }); const done = new Promise(resolve => { finish = resolve; });
    const first = operation.run(806, async () => { enter(); await done; }); await entered;
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "const {Pool}=require('pg');const p=new Pool(require('./database/config').connectionConfig());const op=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(p);op.run(806,()=>{throw Error('Must not run')}).then(()=>process.exitCode=2,e=>{if(e.code!=='INSTANCE_OPERATION_BUSY')process.exitCode=3}).finally(()=>p.end());"], { cwd: require('node:path').join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore','ignore','ignore'] });
    try { assert.equal(await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve); }), 0); }
    finally { finish(); await first; }
  });
  await t.test('cross-model transfer cannot release a reserved principal; rollback retains both sources', async () => {
    await operation.run(806, async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await assert.rejects(c.query('UPDATE ' + s + '.assinaturas SET whatsapp_session=NULL WHERE id=806'), error => error.code === '23514');
        await c.query('ROLLBACK');
        assert.equal((await pool.query('SELECT instance_name FROM "' + alternative + '".whatsapp_sessions WHERE salon_id=$1',[salon])).rows[0].instance_name,null);
      } finally { c.release(); }
    });
  });
  await t.test('callback rejection retains the fence and sanitized error; wrong token or owner cannot release', async () => {
    let failure;
    try { await operation.run(806, async () => { throw Error('PRIVATE_SYNTHETIC_EXCEPTION'); }); } catch (error) { failure = error; }
    assert.equal(failure.code, 'INSTANCE_OPERATION_UNCERTAIN'); assert.ok(!JSON.stringify(failure).includes('PRIVATE')); assert.ok(!failure.cause);
    await assert.rejects(assign(806, null), error => error.code === '23514');
    await assert.rejects(operation.acknowledgeStoppedOperation(806, randomUUID()), { code: 'INSTANCE_OPERATION_MISMATCH' });
    await assert.rejects(operation.acknowledgeStoppedOperation(807, failure.operationToken), { code: 'INSTANCE_OPERATION_MISMATCH' });
    await operation.acknowledgeStoppedOperation(806, failure.operationToken); assert.equal((await record(806)).operation_token, null);
    await assert.rejects(operation.acknowledgeStoppedOperation(806, failure.operationToken), { code: 'INSTANCE_OPERATION_MISMATCH' });
  });
  await t.test('timeout is bounded even for uncooperative callback; durable fence survives deadline until verified stop', async () => {
    let context, finish; const pending = new Promise(resolve => { finish = resolve; }); const start = Date.now();
    let failure; try { await operation.run(806, async value => { context = value; await pending; }, { timeoutMs: 25 }); } catch (error) { failure = error; }
    assert.equal(failure.code, 'INSTANCE_OPERATION_TIMEOUT'); assert.ok(Date.now() - start < 1500); assert.equal(context.signal.aborted, true);
    assert.throws(() => context.assertActive(), { code: 'INSTANCE_OPERATION_EXPIRED' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const fresh = createEvolutionOwnershipOperation(pool, { schema: env.schema });
    await assert.rejects(fresh.run(806, () => assert.fail('No retry')), { code: 'INSTANCE_OPERATION_BUSY' });
    await assert.rejects(assign(806, 'after-timeout-test'), error => error.code === '23514');
    finish(); await pending; await new Promise(resolve => setImmediate(resolve));
    assert.equal((await record(806)).operation_token, failure.operationToken, 'Late settlement does not silently reconcile');
    await fresh.acknowledgeStoppedOperation(806, failure.operationToken);
  });
  await t.test('reservation and source rollback are atomic', async () => {
    const before = await record(806), c = await pool.connect();
    try { await c.query('BEGIN'); await c.query('UPDATE ' + s + '.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2', [randomUUID(),'806']); await c.query('ROLLBACK'); }
    finally { c.release(); }
    assert.deepEqual(await record(806), before);
    await operation.run(806, async () => {});
  });

  await t.test('process crash leaves a persistent fence; no TTL releases ownership', async () => {
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', "const {Pool}=require('pg');const p=new Pool(require('./database/config').connectionConfig());const op=require('./services/evolutionOwnershipOperation').createEvolutionOwnershipOperation(p);op.run(806,async()=>{process.send('reserved');await new Promise(()=>{})},{timeoutMs:15000}).catch(()=>{});"], { cwd: require('node:path').join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
    const ended = new Promise(resolve => child.once('exit', resolve));
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await new Promise((resolve,reject) => { child.once('error',reject); child.once('message',resolve); });
    const token = (await record(806)).operation_token; assert.ok(token);
    child.kill(); await ended;
    await assert.rejects(operation.run(806, () => assert.fail()), { code: 'INSTANCE_OPERATION_BUSY' });
    await assert.rejects(assign(806, null), e => e.code === '23514');
    await operation.acknowledgeStoppedOperation(806, token);
  });
  await t.test('lost commit acknowledgement never authorizes operation and preserves a committed fence', async () => {
    const wrapped = { async connect() {
      const c = await pool.connect();
      return { on: (...args) => c.on(...args), removeListener: (...args) => c.removeListener(...args), release: (...args) => c.release(...args), async query(config) {
        const result = await c.query(config);
        if (config.text === 'COMMIT') throw Error('Synthetic lost acknowledgement');
        return result;
      } };
    } };
    const guarded = createEvolutionOwnershipOperation(wrapped, { schema: env.schema });
    await assert.rejects(guarded.run(806, () => assert.fail('Callback must not run after unknown commit')), { code: 'INSTANCE_OPERATION_FAILED' });
    const token = (await record(806)).operation_token; assert.ok(token);
    await assert.rejects(assign(806, null), e => e.code === '23514');
    await operation.acknowledgeStoppedOperation(806, token);
  });
  await t.test('pool acquisition failure is sanitized and never invokes operation', async () => {
    const fake = createEvolutionOwnershipOperation({ connect: async () => { throw Error('PRIVATE_CONNECTION'); } });
    await assert.rejects(fake.run(806, () => assert.fail()), e => e.code === 'INSTANCE_OPERATION_FAILED' && !e.message.includes('PRIVATE'));
  });
  await t.test('pool acquisition deadline returns late connections without authorizing operation', async () => {
    let resolve, released = 0; const connection = new Promise(r => { resolve = r; });
    const fake = createEvolutionOwnershipOperation({ connect: () => connection });
    await assert.rejects(fake.run(806, () => assert.fail()), { code: 'INSTANCE_OPERATION_BUSY' });
    resolve({ release() { released++; } }); await new Promise(r => setImmediate(r)); assert.equal(released, 1);
  });
  assert.equal(network, 0);
});
