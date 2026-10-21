const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash,randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');

test('030: additive upgrade, transactional rollback, concurrent runners, no legacy authorization', { timeout:90000 },async t=>{
  const env=require('./helpers/postgres').testEnvironment();
  const pool=new Pool(require('../database/config').connectionConfig());
  t.after(async()=>{await pool.end();await env.cleanup();});
  const directory=path.join(__dirname,'../database/migrations'),filename='030_execution_authorization_lease.sql';
  const sql=fs.readFileSync(path.join(directory,filename),'utf8');
  const names=fs.readdirSync(directory).filter(n=>n.endsWith('.sql')&&n<filename).sort();
  const c=await pool.connect();
  try {
    await c.query('BEGIN');await c.query('CREATE SCHEMA "'+env.schema+'"');
    await c.query('SET LOCAL search_path TO "'+env.schema+'",public');
    await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await c.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
    for(const name of names){const contents=fs.readFileSync(path.join(directory,name),'utf8');await c.query(contents);await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(contents).digest('hex')]);}
    await c.query('COMMIT');
  } finally {c.release();}
  const q=(sql,args=[])=>pool.query(sql,args);
  await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES(93001,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','legacy-lease-93001')");
  const token=randomUUID(),claim=randomUUID(),executor=randomUUID(),execution=randomUUID();
  await q("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='93001'",[token]);
  await q('INSERT INTO evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,1,clock_timestamp())',[executor,randomUUID()]);
  await q("INSERT INTO evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind) VALUES($1,$2,$3,93001,'legacy-lease-93001','instance_operation')",[execution,executor,token]);
  await q("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,attempts,claim_token,operation_token,dispatch_started_at) VALUES(93001,'legacy-lease-93001','5511999990000',$1,'Synthetic legacy','uncertain',1,$2,$3,clock_timestamp())",[randomUUID(),claim,token]);
  const tables=['whatsapp_messages','evolution_instance_owners','evolution_operation_executions','evolution_executors','schema_migrations'];
  const snapshot=async()=>{const result={};for(const name of tables)result[name]=(await q('SELECT * FROM '+name+' ORDER BY 1')).rows;return result;};
  const before=await snapshot();
  await t.test('rollback removes all new structures and leaves legacy evidence unchanged',async()=>{
    const c=await pool.connect();try{await c.query('BEGIN');await c.query(sql);assert.equal((await c.query('SHOW lock_timeout')).rows[0].lock_timeout,'2s');await assert.rejects(c.query('SELECT 1/0'));await c.query('ROLLBACK');}finally{c.release();}
    assert.equal((await q("SELECT to_regclass('evolution_execution_authorizations') AS t")).rows[0].t,null);
    assert.deepEqual(await snapshot(),before);
  });
  await t.test('delivery DDL contention fails within lock_timeout and rolls the entire migration back',async()=>{
    const holder=await pool.connect(),runner=await pool.connect();
    try {
      await holder.query('BEGIN');await holder.query('LOCK TABLE whatsapp_messages IN ROW EXCLUSIVE MODE');
      await runner.query('BEGIN');await assert.rejects(runner.query(sql),e=>e.code==='55P03');await runner.query('ROLLBACK');
      assert.equal((await q("SELECT to_regclass('evolution_execution_authorizations') AS t")).rows[0].t,null);
    } finally {await holder.query('ROLLBACK');holder.release();runner.release();}
    assert.deepEqual(await snapshot(),before);
  });
  await t.test('two startup migrators apply 030 once without inventing legacy leases',async()=>{
    await Promise.all([migrate(pool,env.schema),migrate(pool,env.schema)]);
    const after=await snapshot();for(const name of tables.filter(n=>n!=='schema_migrations'))assert.deepEqual(after[name],before[name]);
    assert.equal((await q('SELECT count(*)::int n FROM evolution_execution_authorizations')).rows[0].n,0);
    assert.equal((await q('SELECT authorization_state FROM evolution_execution_authorization_status WHERE execution_id=$1',[execution])).rows[0].authorization_state,null);
    for(const row of before.schema_migrations)assert.deepEqual(after.schema_migrations.find(r=>r.name===row.name),row);
    const applied=after.schema_migrations.filter(r=>r.name===filename);assert.equal(applied.length,1);assert.equal(applied[0].checksum,createHash('sha256').update(sql).digest('hex'));
  });
  await t.test('old execution cannot receive a retroactive authorization',async()=>{
    await assert.rejects(q('INSERT INTO evolution_execution_authorizations(execution_id) VALUES($1)',[execution]),e=>e.code==='23514');
    assert.equal((await q('SELECT count(*)::int n FROM evolution_execution_authorizations')).rows[0].n,0);
    assert.deepEqual((await q('SELECT * FROM evolution_operation_executions ORDER BY 1')).rows,before.evolution_operation_executions);
  });
});
