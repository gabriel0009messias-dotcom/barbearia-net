const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/conversation');

test('027: validated upgrade preserves rows/storage, bounds lock wait and rolls back atomically', async t => {
  const fs = require('node:fs'), path = require('node:path');
  const env = require('./helpers/postgres').testEnvironment();
  const directory = path.resolve(__dirname, '../database/migrations');
  const readdir = fs.readdirSync;
  const discovery = t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    const files = readdir.call(this, dir, ...args);
    return path.resolve(String(dir)) === directory ? files.filter(n => n < '027_') : files;
  });
  const pool = new (require('pg').Pool)(require('../database/config').connectionConfig());
  try { await require('../database/migrate').migrate(pool, env.schema); } finally { discovery.mock.restore(); }
  let client, blocker;
  t.after(async () => { client?.release(); blocker?.release(); await pool.end(); await env.cleanup(); });
  await pool.query("INSERT INTO clientes(nome,telefone) VALUES('Legacy','legacy-unvalidated-phone')");
  const tenant = (await pool.query("INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES('Migration fixture','Owner','11999990000','mercado_pago',5,'','migration-provider') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO clientes(assinatura_id,nome,telefone) VALUES($1,'Customer','5511999990001')", [tenant]);
  await pool.query("INSERT INTO whatsapp_conversations(assinatura_id,instance_key,owner_epoch,sender,reference) SELECT $1,instance_key,conversation_epoch,'5511999990001','0123456789abcdef' FROM evolution_instance_owners WHERE instance_key='migration-provider'", [tenant]);
  const sql = fs.readFileSync(path.join(directory, '027_whatsapp_provider_identity.sql'), 'utf8');
  const snapshot = async client => ({
    customers: (await client.query('SELECT * FROM clientes ORDER BY id')).rows,
    conversations: (await client.query('SELECT * FROM whatsapp_conversations ORDER BY id')).rows,
    storage: (await client.query("SELECT relname,relfilenode FROM pg_class WHERE oid IN ('clientes'::regclass,'whatsapp_conversations'::regclass) ORDER BY relname")).rows,
    access: (await client.query('SELECT * FROM public_booking_access ORDER BY appointment_id')).rows,
    constraints: (await client.query("SELECT conname,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname IN ('customer_tenant_phone','whatsapp_conversations_sender_check','booking_confirmation_snapshot_shape') AND connamespace=current_schema()::regnamespace ORDER BY conname")).rows,
  });
  client = await pool.connect(); blocker = await pool.connect();
  const before = await snapshot(client);
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='750ms'");
  const start = performance.now(); await client.query(sql);
  const duration = performance.now() - start;
  const after = await snapshot(client);
  assert.deepEqual(after.customers, before.customers);
  assert.deepEqual(after.conversations, before.conversations);
  assert.deepEqual(after.storage, before.storage);
  assert.deepEqual(after.access, before.access);
  assert.ok(after.constraints.every(c => c.convalidated && c.definition.includes('[2-9]')));
  assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '750ms');
  const locks = (await client.query("SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation IN ('clientes'::regclass,'whatsapp_conversations'::regclass) AND mode='AccessExclusiveLock'")).rows;
  assert.equal(locks.length, 2);
  await client.query('ROLLBACK');
  assert.deepEqual(await snapshot(client), before);
  t.diagnostic('027 local DDL duration_ms=' + duration.toFixed(2));
  await blocker.query('BEGIN'); await blocker.query('SELECT 1 FROM clientes LIMIT 1');
  await client.query('BEGIN');
  try { await assert.rejects(client.query(sql), e => e.code === '55P03'); }
  finally { await client.query('ROLLBACK'); await blocker.query('ROLLBACK'); }
  assert.deepEqual(await snapshot(client), before);
  client.release(); blocker.release(); client = blocker = undefined;
  await require('../database/migrate').migrate(pool, env.schema);
  const check = await pool.connect();
  try { assert.ok((await snapshot(check)).constraints.every(c => c.convalidated)); }
  finally { check.release(); }
});

test('Evolution 2.3.7: eight-digit mobile PN survives capture, identity and delivery unchanged', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'conversation-test-secret';
  const db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  const f = await fixture(db, { known: false });
  // Synthetic values with the same PN shape as the incident; never infer PN from LID.
  const phone = '551188887777';
  const event = f.payload('oi', { phone, id: 'synthetic-provider-eight-digit' });
  event.data.key.remoteJid = '123456789012345@lid';
  event.data.key.remoteJidAlt = phone + '@s.whatsapp.net';
  const input = f.webhook.extract(event);
  assert.equal(input.phone, phone);
  const result = await f.webhook.processarWebhookEvolution(event, f.headers, { deferDelivery: true });
  assert.equal(result.ignored, undefined, JSON.stringify(result));
  const capture = await db.getAsync('SELECT decision,sender FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2', [f.instance,event.data.key.id]);
  assert.deepEqual(capture, { decision: 'processed', sender: phone });
  assert.equal((await f.state(phone)).state.step, 'ASK_NAME');
  assert.equal((await db.getAsync('SELECT telefone FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,phone])).telefone, phone);
  let sends = 0;
  await f.webhook.drain(async (instance, destination) => {
    sends++; assert.equal(instance, f.instance); assert.equal(destination, phone);
    return { key: { id: 'synthetic-provider-reply' }, status: 'PENDING' };
  });
  assert.equal(sends, 1);
  assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE instance=$1 AND message_id=$2',[f.instance,event.data.key.id])).status, 'sent');
  assert.equal((await f.webhook.processarWebhookEvolution(event,f.headers,{deferDelivery:true})).duplicate, true);
  await f.webhook.drain(async () => { throw Error('Duplicate must not send'); });
  assert.equal(sends, 1);
  const direct = f.payload('oi', { phone, id: 'synthetic-direct-pn' });
  assert.equal(f.webhook.extract(direct).phone, phone);
  const lidOnly = f.payload('oi'); lidOnly.data.key.remoteJid='123456789012345@lid';
  assert.equal(f.webhook.extract(lidOnly), null);
  const outgoing = f.payload('oi', { phone }); outgoing.data.key.fromMe=true;
  assert.equal(f.webhook.extract(outgoing), null);
  await assert.rejects(f.webhook.processarWebhookEvolution(event,{'x-webhook-secret':'wrong'},{deferDelivery:true}), e=>e.statusCode===401);
  // The public booking validator must remain strict and must never add a ninth digit.
  assert.equal(require('../services/whatsapp/phone').normalizeBrazilianDestination(phone), null);
  const customer = require('../services/whatsapp/customerIdentity');
  for (const invalid of ['123456789012345','12025550123','551100001111','+551188887777'])
    await assert.rejects(customer.identifyCustomer(db,f.tenant,invalid), /Invalid customer identity/);
  await assert.rejects(db.runAsync("INSERT INTO clientes(assinatura_id,telefone,nome) VALUES($1,'551100001111','Invalid')",[f.tenant]), e=>e.code==='23514');
  await assert.rejects(db.runAsync("UPDATE whatsapp_conversations SET sender='123456789012345' WHERE assinatura_id=$1",[f.tenant]), e=>e.code==='23514');

  // Exact strings are separate identities, including the plausible ninth-digit
  // variant. Equal provider IDs/phones in distinct owned instances stay scoped.
  const normal = '5511988887777';
  const second = await fixture(db, { known: false });
  for (const [owner, destination] of [[f, normal], [second, phone]]) {
    const e = owner.payload('oi', { phone: destination, id: owner === f ? 'synthetic-provider-normal' : 'synthetic-provider-eight-digit' });
    assert.equal((await owner.webhook.processarWebhookEvolution(e, owner.headers, { deferDelivery: true })).ignored, undefined);
    assert.equal((await owner.state(destination)).state.step, 'ASK_NAME');
  }
  const customers = await db.allAsync('SELECT id,assinatura_id,telefone FROM clientes WHERE assinatura_id=ANY($1::bigint[]) ORDER BY id', [[f.tenant, second.tenant]]);
  assert.equal(customers.length, 3);
  assert.equal(new Set(customers.map(c => c.id)).size, 3);
  assert.equal(customers.filter(c => c.telefone === phone).length, 2);
  const before = await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages');
  for (const invalid of ['12025550123', '551100001111']) {
    const e = f.payload('oi', { phone: invalid });
    assert.equal(f.webhook.extract(e).phone, invalid);
    const rejected = await f.webhook.processarWebhookEvolution(e, f.headers, { deferDelivery: true });
    assert.equal(rejected.ignored, true);
    assert.equal(rejected.reason, 'invalid_event');
    assert.equal(await f.state(invalid), undefined);
  }
  for (const jid of ['551188887777@evil.test', 'invalid@s.whatsapp.net', '551188887777@g.us', '123456789012345@lid']) {
    const e = f.payload('oi'); e.data.key.remoteJid = jid;
    assert.equal(f.webhook.extract(e), null);
  }
  const conflict = f.payload('different content', { phone, id: event.data.key.id });
  assert.equal((await f.webhook.processarWebhookEvolution(conflict, f.headers, { deferDelivery: true })).reason, 'event_identity_mismatch');
  assert.deepEqual(await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages'), before);
  assert.equal((await f.state(phone)).state.step, 'ASK_NAME');
});
