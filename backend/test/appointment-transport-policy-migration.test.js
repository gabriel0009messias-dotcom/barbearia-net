const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { migrate } = require('../database/migrate');

test('025 upgrade: no activation, no historical rewrite, transactional and repeatable', { timeout: 90000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const directory = path.resolve(__dirname, '../database/migrations'), file = '025_appointment_reminder_transport_policy.sql';
  const read = fs.readdirSync;
  const discovery = t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    const files = read.call(this, dir, ...args);
    return path.resolve(String(dir)) === directory ? files.filter(name => name < '025_') : files;
  });
  const db = require('../database'); try { await db.ready; } finally { discovery.mock.restore(); }
  t.after(async () => { await db.close(); await env.cleanup(); });
  const q = (sql, values) => db.pool.query(sql, values), key = 'appointment_reminder_transport_policy_v1';
  const tenant = (await q(`INSERT INTO assinaturas(barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero)
    VALUES('Synthetic migration','Owner','11999990000','mercado_pago',5,'') RETURNING id`)).rows[0].id;
  for (const [index, status] of ['pending', 'sending', 'sent', 'uncertain', 'cancelled', 'expired', 'failed'].entries()) {
    const a = (await q(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,data,hora,status)
      VALUES($1,'Synthetic migration client','5511999990000','Service','2030-01-02',$2,'confirmado') RETURNING id`, [tenant, `${10 + index}:00`])).rows[0];
    await q(`UPDATE appointment_reminders SET status=$1,claim_token=gen_random_uuid(),attempts=1,
      dispatch_started_at=CASE WHEN $1 IN ('sent','uncertain') THEN clock_timestamp() ELSE NULL END,
      sent_at=CASE WHEN $1='sent' THEN clock_timestamp() ELSE NULL END WHERE appointment_id=$2`, [status, a.id]);
  }
  const before = (await q('SELECT * FROM appointment_reminders ORDER BY id')).rows;
  const sources = (await q('SELECT * FROM agendamentos ORDER BY id')).rows;
  const sql = fs.readFileSync(path.join(directory, file), 'utf8');
  await t.test('active preseeded policy is rejected and all 025 DDL rolls back', async () => {
    await q('INSERT INTO configuracoes(chave,valor) VALUES($1,$2)', [key, JSON.stringify({ version: 1, enabled: true, scope: 'all', assinatura_ids: [] })]);
    await assert.rejects(migrate(db.pool, env.schema), /Initial appointment reminder transport policy must be disabled/);
    assert.equal((await q("SELECT to_regprocedure($1) routine", [env.schema + '.studiofy_appointment_transport_allowed(bigint)'])).rows[0].routine, null);
    assert.equal((await q('SELECT count(*)::int n FROM schema_migrations WHERE name=$1', [file])).rows[0].n, 0);
    await q('DELETE FROM configuracoes WHERE chave=$1', [key]);
  });
  await t.test('complete DDL rollback leaves old rows and routines unchanged', async () => {
    const c = await db.pool.connect();
    try { await c.query('BEGIN'); await c.query(sql); await c.query('ROLLBACK'); }
    finally { c.release(); }
    assert.deepEqual((await q('SELECT * FROM appointment_reminders ORDER BY id')).rows, before);
    assert.equal((await q("SELECT to_regprocedure($1) routine", [env.schema + '.studiofy_appointment_transport_allowed(bigint)'])).rows[0].routine, null);
  });
  await t.test('concurrent runner and restart install once without any policy seed or reminder rewrite', async () => {
    await Promise.all([migrate(db.pool, env.schema), migrate(db.pool, env.schema)]); await migrate(db.pool, env.schema);
    assert.equal((await q('SELECT count(*)::int n FROM schema_migrations WHERE name=$1', [file])).rows[0].n, 1);
    assert.equal((await q('SELECT count(*)::int n FROM configuracoes WHERE chave=$1', [key])).rows[0].n, 0);
    assert.deepEqual((await q('SELECT * FROM appointment_reminders ORDER BY id')).rows, before);
    assert.deepEqual((await q('SELECT * FROM agendamentos ORDER BY id')).rows, sources);
    assert.equal((await q('SELECT studiofy_appointment_transport_allowed($1) allowed', [tenant])).rows[0].allowed, false);
  });
  await t.test('020-024 checksums and approved window/return guards remain installed', async () => {
    const migrations = (await q("SELECT name,checksum FROM schema_migrations WHERE name>='020_' AND name<'025_' ORDER BY name")).rows;
    assert.equal(migrations.length, 5);
    for (const row of migrations) assert.equal(row.checksum, createHash('sha256').update(fs.readFileSync(path.join(directory, row.name))).digest('hex'));
    const triggers = (await q("SELECT tgname FROM pg_trigger WHERE tgrelid='appointment_reminders'::regclass AND NOT tgisinternal")).rows.map(r => r.tgname);
    assert.ok(triggers.includes('studiofy_reminder_window_guard')); assert.ok(triggers.includes('studiofy_delivery_state_guard'));
    assert.ok(triggers.includes('studiofy_appointment_transport_guard'));
    assert.equal((await q("SELECT count(*)::int n FROM configuracoes WHERE chave='return_outbox_delivery_enabled'")).rows[0].n, 0);
  });
});
