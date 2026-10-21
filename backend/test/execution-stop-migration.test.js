const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');

test('031: transactional additive upgrade, no legacy backfill, bounded DDL and concurrent idempotency', {timeout:90000},async t=>{
  const env=require('./helpers/postgres').testEnvironment(),pool=new Pool({...require('../database/config').connectionConfig(),max:6});
  t.after(async()=>{await pool.end();await env.cleanup();});
  const dir=path.join(__dirname,'../database/migrations'),filename='031_execution_stop_proofs.sql',sql=fs.readFileSync(path.join(dir,filename),'utf8');
  const names=fs.readdirSync(dir).filter(n=>n.endsWith('.sql')&&n<filename).sort(),q=(sql,args=[])=>pool.query(sql,args);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');await c.query('CREATE SCHEMA "'+env.schema+'"');await c.query('SET LOCAL search_path TO "'+env.schema+'",public');
    await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    await c.query("SELECT set_config('studiofy.evolution_legacy_schema','public',true)");
    for(const name of names){const content=fs.readFileSync(path.join(dir,name),'utf8');await c.query(content);await c.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,createHash('sha256').update(content).digest('hex')]);}
    await c.query('COMMIT');
  }finally{c.release();}
  const token=randomUUID(),executor=randomUUID(),execution=randomUUID(),boot=randomUUID();
  await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session) VALUES(97001,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','legacy-stop-97001')");
  await q("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='97001'",[token]);
  await q('INSERT INTO evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,1,clock_timestamp())',[executor,boot]);
  await q("INSERT INTO evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind) VALUES($1,$2,$3,97001,'legacy-stop-97001','instance_operation')",[execution,executor,token]);
  // Historical delivery 37 equivalent, isolated fixture only, deliberately unbound.
  await q("INSERT INTO whatsapp_messages(id,assinatura_id,instance,phone,message_id,response,status,attempts,claim_token,operation_token,dispatch_started_at) VALUES(37,97001,'legacy-stop-97001','5511999990000',$1,'Synthetic','uncertain',1,$2,$3,clock_timestamp())",[randomUUID(),randomUUID(),token]);
  const tables=['assinaturas','whatsapp_messages','evolution_instance_owners','evolution_operation_executions','evolution_executors','evolution_execution_authorizations','evolution_delivery_reconciliations','whatsapp_conversations','schema_migrations'];
  const snapshot=async()=>{const data={};for(const table of tables)data[table]=(await q('SELECT * FROM '+table+' ORDER BY 1')).rows;return data;};
  const before=await snapshot();
  await t.test('full rollback removes 031 structures and retains every original row',async()=>{
    const c=await pool.connect();try{await c.query('BEGIN');await c.query(sql);assert.equal((await c.query('SHOW lock_timeout')).rows[0].lock_timeout,'2s');
      await assert.rejects(c.query('SELECT 1/0'));await c.query('ROLLBACK');}finally{c.release();}
    assert.equal((await q("SELECT to_regclass('evolution_execution_stops') t")).rows[0].t,null);assert.deepEqual(await snapshot(),before);
  });
  await t.test('DDL contention rolls back within lock timeout',async()=>{
    const a=await pool.connect(),b=await pool.connect();try{await a.query('BEGIN');await a.query('LOCK TABLE whatsapp_messages IN ROW EXCLUSIVE MODE');
      await b.query('BEGIN');await assert.rejects(b.query(sql),e=>e.code==='55P03');await b.query('ROLLBACK');
      assert.equal((await q("SELECT to_regclass('evolution_supervisors') t")).rows[0].t,null);
    }finally{await a.query('ROLLBACK');a.release();b.release();}assert.deepEqual(await snapshot(),before);
  });
  await t.test('deployment default ACLs cannot accidentally grant new evidence DML or issuer APIs',async()=>{
    const c=await pool.connect(),role='test_stop_acl_'+randomUUID().replaceAll('-','');
    try{
      await c.query('BEGIN');await c.query('CREATE ROLE "'+role+'" NOLOGIN');
      await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA "'+env.schema+'" GRANT ALL ON TABLES TO "'+role+'"');
      await c.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO "'+role+'"');
      await c.query(sql);
      const tables=(await c.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=$1 AND c.relname LIKE 'evolution_%' AND r.rolname=$2",[env.schema,role])).rows[0].n;
      const funcs=(await c.query("SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE n.nspname=$1 AND r.rolname=$2",[env.schema,role])).rows[0].n;
      assert.equal(tables,0);assert.equal(funcs,0);
    }finally{await c.query('ROLLBACK');c.release();}
    assert.deepEqual(await snapshot(),before);
  });
  await t.test('two migration runners apply once; all 001-030 checksums and legacy rows remain byte-for-byte equivalent',async()=>{
    await Promise.all([migrate(pool,env.schema),migrate(pool,env.schema)]);const after=await snapshot();
    for(const table of tables.filter(n=>n!=='schema_migrations'))assert.deepEqual(after[table],before[table]);
    for(const row of before.schema_migrations){assert.deepEqual(after.schema_migrations.find(r=>r.name===row.name),row);
      assert.equal(createHash('sha256').update(fs.readFileSync(path.join(dir,row.name))).digest('hex'),row.checksum);}
    assert.equal(after.schema_migrations.filter(r=>r.name===filename).length,1);
    for(const suffix of ['supervisors','executor_birth_bindings','executor_gates','executor_closure_events','execution_stop_proofs','execution_stops'])
      assert.equal((await q('SELECT count(*)::int n FROM evolution_'+suffix)).rows[0].n,0);
  });
  await t.test('old and current unbound boots operate normally without fabricated gates, proofs or STOPPED',async()=>{
    await q("UPDATE evolution_execution_authorizations SET state='ACTIVE' WHERE execution_id=$1",[execution]);
    const after=(await q('SELECT * FROM whatsapp_messages WHERE id=37')).rows[0];assert.deepEqual(after,before.whatsapp_messages[0]);
    assert.equal((await q('SELECT state FROM evolution_operation_executions WHERE execution_id=$1',[execution])).rows[0].state,'ACTIVE');
    assert.equal((await q('SELECT count(*)::int n FROM evolution_execution_stops')).rows[0].n,0);
  });
});
