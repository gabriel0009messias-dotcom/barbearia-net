const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');
const { materializeBookingConfirmations, captureBookingConfirmation } = require('../services/bookingConfirmation');
const { classifyBrazilianDestination } = require('../services/whatsapp/phone');

test('020: legacy upgrade, rollback, BIGINT identity and no historical confirmations', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const pool = new Pool(require('../database/config').connectionConfig());
  const c = await pool.connect(), directory = path.join(__dirname, '../database/migrations');
  const sql = fs.readFileSync(path.join(directory, '020_booking_confirmation.sql'), 'utf8');
  t.after(async () => { c.release(); await pool.end(); await env.cleanup(); });
  await c.query('BEGIN'); await c.query('CREATE SCHEMA "' + env.schema + '"'); await c.query('SET LOCAL search_path TO "' + env.schema + '",public');
  await c.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
  await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.sql') && n < '020').sort()) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8'); await c.query(text);
    await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name, createHash('sha256').update(text).digest('hex')]);
  }
  await c.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES(2147483648,'Legacy Studio','Owner','11999990000','mercado_pago',5,'','migration-booking-test')");
  const row = (await c.query("INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,status) VALUES(2147483648,'Legacy Customer','5575999999999','Historical Service',30,'2030-01-02','10:00','confirmado') RETURNING id")).rows[0];
  await c.query('INSERT INTO public_booking_access(appointment_id,token_hash) VALUES($1,$2)', [row.id, 'a'.repeat(64)]);
  await c.query('COMMIT');
  const legacy = (await c.query('SELECT * FROM agendamentos')).rows;
  const legacyAccess = (await c.query('SELECT * FROM public_booking_access')).rows;
  const wrapper = { getAsync: async (...a) => (await pool.query(...a)).rows[0], runAsync: async (...a) => ({ changes: (await pool.query(...a)).rowCount }), transaction: async work => {
    const conn = await pool.connect();
    try { await conn.query('BEGIN'); const result = await work({ getAsync: async (...a) => (await conn.query(...a)).rows[0], runAsync: async (...a) => ({ changes: (await conn.query(...a)).rowCount }) }); await conn.query('COMMIT'); return result; }
    catch (e) { await conn.query('ROLLBACK'); throw e; } finally { conn.release(); }
  } };
  await t.test('transaction rollback removes all new columns, indexes and triggers and preserves old data', async () => {
    await c.query('BEGIN'); await c.query(sql); await c.query('ROLLBACK');
    assert.deepEqual((await c.query('SELECT * FROM agendamentos')).rows, legacy);
    assert.deepEqual((await c.query('SELECT * FROM public_booking_access')).rows, legacyAccess);
    assert.equal((await c.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND column_name IN ('confirmation_snapshot','booking_confirmation_appointment_id')", [env.schema])).rows[0].n, 0);
    assert.equal((await c.query("SELECT to_regclass($1) value", [env.schema + '.booking_confirmation_once'])).rows[0].value, null);
  });
  await t.test('normal runner upgrades and repeats without modifying historical bookings or enqueueing them', async () => {
    await migrate(pool); await migrate(pool); await materializeBookingConfirmations(wrapper);
    assert.deepEqual((await c.query('SELECT * FROM agendamentos')).rows, legacy);
    const access = (await c.query('SELECT * FROM public_booking_access')).rows[0]; assert.equal(access.confirmation_snapshot, null);
    assert.equal(access.token_hash, legacyAccess[0].token_hash); assert.equal((await c.query('SELECT count(*)::int n FROM whatsapp_messages')).rows[0].n, 0);
    assert.equal((await c.query("SELECT count(*)::int n FROM schema_migrations WHERE name='020_booking_confirmation.sql'")).rows[0].n, 1);
  });
  await t.test('CONF-AUD-01: missing original phone has a durable non-routable state, never the legacy phone', async () => {
    await c.query('BEGIN');
    try {
      await captureBookingConfirmation({ runAsync: async (...args) => ({ changes: (await c.query(...args)).rowCount }) }, 2147483648, row.id, classifyBrazilianDestination(null));
      const snapshot = (await c.query('SELECT confirmation_snapshot FROM public_booking_access')).rows[0].confirmation_snapshot;
      assert.equal(snapshot.phone_state, 'missing'); assert.equal(snapshot.telefone, null);
    } finally { await c.query('ROLLBACK'); }
  });
  for (const [state, destination] of [['invalid', '5555999999999'], ['missing', '5555999999999'], ['routable', '+55 99999-9999'], ['routable', null]]) {
    await t.test('CONF-AUD-01: PostgreSQL rejects inconsistent phone decision ' + state + '/' + destination, async () => {
      await c.query('BEGIN');
      try {
        const snapshot = { appointment_id: String(row.id), assinatura_id: '2147483648', cliente: 'Synthetic', telefone: destination, phone_state: state, servico: 'Service', preco: 30, data: '2030-01-02', hora: '10:00', estabelecimento: 'Synthetic', instance: 'migration-booking-test' };
        await assert.rejects(c.query('UPDATE public_booking_access SET confirmation_snapshot=$1::jsonb WHERE appointment_id=$2', [JSON.stringify(snapshot), row.id]), e => e.code === '23514');
      } finally { await c.query('ROLLBACK'); }
    });
  }
  await t.test('new origin with an int32-exceeding tenant uses BIGINT end to end', async () => {
    await captureBookingConfirmation(wrapper, 2147483648, row.id, classifyBrazilianDestination('5575999999999')); await materializeBookingConfirmations(wrapper);
    const queued = (await c.query('SELECT * FROM whatsapp_messages')).rows[0]; assert.equal(queued.assinatura_id, 2147483648); assert.equal(queued.booking_confirmation_appointment_id, row.id);
    const column = (await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='whatsapp_messages' AND column_name='booking_confirmation_appointment_id'", [env.schema])).rows[0]; assert.equal(column.data_type, 'bigint');
    assert.equal((await c.query('SELECT confirmation_snapshot FROM public_booking_access')).rows[0].confirmation_snapshot.assinatura_id, '2147483648');
  });
  await t.test('outbox identity survives access revocation; no cascade deletes uncertain evidence', async () => {
    const queued = (await c.query('SELECT * FROM whatsapp_messages')).rows[0];
    await c.query("UPDATE whatsapp_messages SET status='uncertain',claim_token=$1,dispatch_started_at=CURRENT_TIMESTAMP WHERE id=$2", [randomUUID(), queued.id]);
    await c.query('DELETE FROM public_booking_access WHERE appointment_id=$1', [row.id]);
    assert.equal((await c.query('SELECT status FROM whatsapp_messages WHERE id=$1', [queued.id])).rows[0].status, 'uncertain');
    assert.equal((await c.query('SELECT status FROM agendamentos WHERE id=$1', [row.id])).rows[0].status, 'confirmado');
  });
});
