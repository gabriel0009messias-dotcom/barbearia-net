const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('../database/migrate');

test('migration 024: populated legacy schema, transaction rollback and runner reexecution', { timeout: 90000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const directory = path.resolve(__dirname, '../database/migrations'), file = '024_return_reminder_outbox.sql';
  const read = fs.readdirSync;
  const discovery = t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    const files = read.call(this, dir, ...args);
    return path.resolve(String(dir)) === directory ? files.filter(name => name < '024_') : files;
  });
  const db = require('../database'); try { await db.ready; } finally { discovery.mock.restore(); }
  t.after(async () => { await db.close(); await env.cleanup(); });
  const q = (sql, values) => db.pool.query(sql, values);
  const owner = (await q(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,
    suporte_numero,whatsapp_session) VALUES('Legacy establishment','Owner','11999990000','mercado_pago',5,'','return-migration-test') RETURNING id`)).rows[0].id;
  for (const status of ['pending', 'processing', 'sent', 'failed', 'uncertain', 'suppressed', 'cancelled']) {
    const sid = (await q("INSERT INTO servicos_assinatura(assinatura_id,nome,preco) VALUES($1,'Legacy service',30) RETURNING id", [owner])).rows[0].id;
    const id = (await q(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,data,hora,status,studio_service_id)
      VALUES($1,'Legacy client','11999990000','Legacy service','2020-01-01','10:00','confirmado',$2) RETURNING id`, [owner, sid])).rows[0].id;
    await q("UPDATE agendamentos SET status='concluido' WHERE id=$1", [id]);
    await db.transaction(async c => {
      const r = await c.getAsync('SELECT * FROM return_reminders WHERE appointment_id=$1', [id]);
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [owner, r.customer_key, r.service_identity]);
      await c.runAsync(`UPDATE return_reminders SET status=$1,attempts=2,
        dispatch_started_at=CASE WHEN $1 IN ('sent','uncertain') THEN clock_timestamp() ELSE NULL END,
        provider_message_id=CASE WHEN $1='sent' THEN 'simulated:historical-evidence' ELSE NULL END,
        sent_at=CASE WHEN $1='sent' THEN clock_timestamp() ELSE NULL END WHERE id=$2`, [status, r.id]);
    });
  }
  const before = (await q('SELECT * FROM return_reminders ORDER BY id')).rows;
  const appointments = (await q('SELECT * FROM agendamentos ORDER BY id')).rows;
  const sql = fs.readFileSync(path.join(directory, file), 'utf8');
  await t.test('failed activation precondition rolls back all DDL', async () => {
    await q("INSERT INTO configuracoes(chave,valor) VALUES('return_outbox_delivery_enabled','true')");
    await assert.rejects(migrate(db.pool, env.schema), /explicit post-installation approval/);
    assert.equal((await q("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='whatsapp_messages' AND column_name='return_reminder_id'", [env.schema])).rows[0].n, 0);
    assert.equal((await q('SELECT count(*)::int n FROM schema_migrations WHERE name=$1', [file])).rows[0].n, 0);
    await q("UPDATE configuracoes SET valor='false' WHERE chave='return_outbox_delivery_enabled'");
  });
  await t.test('explicit transaction rollback after complete DDL leaves schema 023 untouched', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN'); await c.query(sql);
      assert.equal((await c.query('SELECT count(*)::int n FROM return_reminder_delivery')).rows[0].n, before.length);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.deepEqual((await q('SELECT * FROM return_reminders ORDER BY id')).rows, before);
    assert.equal((await q("SELECT to_regclass($1) relation", [env.schema + '.return_reminder_delivery'])).rows[0].relation, null);
  });
  await t.test('concurrent official runners and repeated restart apply 024 exactly once', async () => {
    await Promise.all([migrate(db.pool, env.schema), migrate(db.pool, env.schema)]); await migrate(db.pool, env.schema);
    assert.equal((await q('SELECT count(*)::int n FROM schema_migrations WHERE name=$1', [file])).rows[0].n, 1);
    assert.equal((await q("SELECT valor FROM configuracoes WHERE chave='return_outbox_delivery_enabled'")).rows[0].valor, 'false');
  });
  await t.test('legacy facts and evidence remain byte-for-byte equivalent without historical invention', async () => {
    const after = (await q('SELECT * FROM return_reminders ORDER BY id')).rows;
    assert.deepEqual(after.map(({ transport_protocol, historical_snapshot_status, establishment_name_snapshot, materialized_at, historical_snapshot_at, snapshot_version, superseded_at, ...r }) => {
      assert.equal(transport_protocol, 'legacy_simulated'); assert.equal(historical_snapshot_status, 'unavailable_legacy');
      assert.equal(establishment_name_snapshot, null); assert.equal(materialized_at, null); return r;
    }), before);
    assert.deepEqual((await q('SELECT * FROM agendamentos ORDER BY id')).rows.map(({ return_history_snapshot, ...a }) => {
      assert.equal(return_history_snapshot, null); return a;
    }), appointments);
    assert.equal((await q('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id IS NOT NULL')).rows[0].n, 0);
  });
  await t.test('composite tenant FK is deferred; binding is unique independently of instance', async () => {
    const fk = (await q("SELECT pg_get_constraintdef(oid) definition,condeferrable,condeferred FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname='return_outbox_source_fk'", [env.schema])).rows[0];
    assert.equal(fk.condeferrable, true); assert.equal(fk.condeferred, true);
    assert.match(fk.definition, /FOREIGN KEY \(assinatura_id, return_reminder_id\)/);
    assert.match((await q("SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname='return_outbox_once'", [env.schema])).rows[0].indexdef,
      /UNIQUE INDEX .*\(return_reminder_id\) WHERE \(return_reminder_id IS NOT NULL\)/);
    await assert.rejects(q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response) VALUES($1,'return-migration-test','5511999990000','return_reminder:999','forged')", [owner]), e => e.code === '23514');
  });
  await t.test('old checksums 020/021/022/023 remain the exact files applied by the runner', async () => {
    const crypto = require('node:crypto');
    const rows = (await q("SELECT name,checksum FROM schema_migrations WHERE name>='020_' AND name<'024_' ORDER BY name")).rows;
    assert.equal(rows.length, 4);
    for (const row of rows) assert.equal(row.checksum, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, row.name))).digest('hex'));
  });
});
