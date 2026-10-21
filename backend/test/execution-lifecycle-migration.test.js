const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');

test('execution foundation migration: upgrade, rollback, legacy preservation and concurrent migrators', { timeout: 90000 }, async t => {
  const env = require('./helpers/postgres').testEnvironment();
  const pool = new Pool(require('../database/config').connectionConfig());
  t.after(async () => { await pool.end(); await env.cleanup(); });
  const directory = path.join(__dirname,'../database/migrations');
  const filename = '029_execution_lifecycle_foundation.sql', sql = fs.readFileSync(path.join(directory,filename),'utf8');
  const oldNames = fs.readdirSync(directory).filter(name => name.endsWith('.sql') && name < filename).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA "' + env.schema + '"');
    await client.query('SET LOCAL search_path TO "' + env.schema + '",public');
    await client.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await client.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
    for (const name of oldNames) {
      const contents = fs.readFileSync(path.join(directory,name),'utf8');
      await client.query(contents);
      await client.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [name,createHash('sha256').update(contents).digest('hex')]);
    }
    await client.query('COMMIT');
  } finally { client.release(); }
  const token = randomUUID(), claim = randomUUID();
  await pool.query("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES(91006,'Synthetic legacy','Synthetic','11999990000','mercado_pago',5,'','legacy-upgrade-stage1')");
  await pool.query("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,attempts,claim_token,operation_token,dispatch_started_at) VALUES(37,91006,'legacy-upgrade-stage1','5511999990000',$1,'Synthetic','uncertain',1,$2,$3,clock_timestamp())", [randomUUID(),claim,token]);
  await pool.query("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='91006'", [token]);
  const tables = ['assinaturas','whatsapp_messages','evolution_instance_owners','evolution_delivery_reconciliations','whatsapp_conversations'];
  const snapshot = async () => {
    const result = {};
    for (const table of tables) result[table] = (await pool.query('SELECT * FROM "' + table + '" ORDER BY 1')).rows;
    return result;
  };
  const before = await snapshot();
  const columns = (await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position", [env.schema,tables])).rows;

  await t.test('DDL is transactional with bounded lock timeout and no historical writes', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(sql);
      assert.equal((await c.query('SHOW lock_timeout')).rows[0].lock_timeout, '2s');
      assert.ok((await c.query("SELECT to_regclass('evolution_operation_executions') AS t")).rows[0].t);
      await c.query('ROLLBACK');
      assert.equal((await c.query("SELECT to_regclass('evolution_operation_executions') AS t")).rows[0].t, null);
    } finally { c.release(); }
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name),oldNames);
  });

  await t.test('migration failure leaves no half-created structures', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(sql);
      await assert.rejects(c.query('SELECT 1/0'));
      await c.query('ROLLBACK');
      assert.equal((await c.query("SELECT to_regclass('evolution_executors') AS t")).rows[0].t, null);
    } finally { c.release(); }
    assert.deepEqual(await snapshot(),before);
  });

  await t.test('concurrent upgrades preserve all legacy rows and register no invented identity', async () => {
    await Promise.all([migrate(pool,env.schema),migrate(pool,env.schema)]);
    assert.deepEqual(await snapshot(),before);
    for (const table of ['evolution_executors','evolution_operation_executions'])
      assert.equal((await pool.query('SELECT count(*)::int n FROM ' + table)).rows[0].n,0);
    assert.deepEqual((await pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name),fs.readdirSync(directory).filter(name => name.endsWith('.sql')).sort());
    const afterColumns = (await pool.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position", [env.schema,tables])).rows;
    assert.deepEqual(afterColumns,columns);
    for (const name of oldNames) assert.equal((await pool.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name])).rows[0].checksum,
      createHash('sha256').update(fs.readFileSync(path.join(directory,name),'utf8')).digest('hex'));
  });

  await t.test('uncertain legacy delivery cannot be retroactively registered as a new execution', async () => {
    const c = await pool.connect(), executor = randomUUID();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,1,clock_timestamp())',[executor,randomUUID()]);
      await assert.rejects(c.query("INSERT INTO evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token) VALUES($1,$2,$3,91006,'legacy-upgrade-stage1','whatsapp_messages',37,$4)", [randomUUID(),executor,token,claim]), error => error.code === '23514');
      await c.query('ROLLBACK');
    } finally { c.release(); }
    assert.deepEqual(await snapshot(),before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM evolution_operation_executions')).rows[0].n,0);
  });
});
