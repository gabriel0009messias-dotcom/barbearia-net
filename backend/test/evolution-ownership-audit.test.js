const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const { auditEvolutionOwnership } = require('../services/evolutionOwnershipAudit');
const schema = () => 'test_' + randomUUID().replaceAll('-', '');

test('Evolution ownership read-only audit: legacy collisions, registry integrity and sanitized snapshot', { timeout: 60000 }, async t => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const main = schema(), alternative = schema(), m='"'+main+'"', a='"'+alternative+'"';
  t.after(async () => { await pool.query('DROP SCHEMA IF EXISTS '+main+' CASCADE'); await pool.query('DROP SCHEMA IF EXISTS '+alternative+' CASCADE'); await pool.end(); });
  await pool.query('CREATE SCHEMA '+m); await pool.query('CREATE SCHEMA '+a);
  await pool.query('CREATE TABLE '+m+'.assinaturas (id bigint PRIMARY KEY,whatsapp_session text)');
  await pool.query('CREATE TABLE '+a+'.whatsapp_sessions (salon_id uuid PRIMARY KEY,instance_name text)');
  const salons=[randomUUID(),randomUUID()];
  await pool.query('INSERT INTO '+m+'.assinaturas VALUES (806,NULL),(807,NULL)');
  for(const salon of salons) await pool.query('INSERT INTO '+a+'.whatsapp_sessions VALUES ($1,NULL)',[salon]);
  const primary=(id,name)=>pool.query('UPDATE '+m+'.assinaturas SET whatsapp_session=$2 WHERE id=$1',[id,name]);
  const alternate=(id,name)=>pool.query('UPDATE '+a+'.whatsapp_sessions SET instance_name=$2 WHERE salon_id=$1',[id,name]);
  const audit=()=>auditEvolutionOwnership(pool,{mainSchema:main,legacySchema:alternative});
  const snapshot=async()=>({main:(await pool.query('SELECT * FROM '+m+'.assinaturas ORDER BY id')).rows,alternative:(await pool.query('SELECT * FROM '+a+'.whatsapp_sessions ORDER BY salon_id')).rows});
  const clear=async()=>{await pool.query('UPDATE '+m+'.assinaturas SET whatsapp_session=NULL');await pool.query('UPDATE '+a+'.whatsapp_sessions SET instance_name=NULL')};
  await t.test('pre-install valid data is inspected without modifying either source',async()=>{await primary(806,'audit-valid-test');const before=await snapshot(),result=await audit();assert.deepEqual(await snapshot(),before);assert.equal(result.safeToInstall,true);assert.equal(result.registryPresent,false);assert.equal(result.associations,1);assert.ok(!JSON.stringify(result).includes('audit-valid-test'))});
  await t.test('detects main/main, alternate/alternate and cross-model collisions by the SQL canonical key',async()=>{
    for(const [one,two,kind]of [[name=>primary(806,name),name=>primary(807,name),'mainMain'],[name=>alternate(salons[0],name),name=>alternate(salons[1],name),'alternateAlternate'],[name=>primary(806,name),name=>alternate(salons[0],name),'crossModel']]){await clear();await one('Same-Instance-Test');await two('same-instance-test');const before=await snapshot(),result=await audit();assert.equal(result.collisions[kind],1);assert.equal(result.safeToInstall,false);assert.deepEqual(await snapshot(),before)}
  });
  await t.test('invalid legacy spelling and spaces are reported; source names never rewritten',async()=>{for(const value of ['invalid/name',' padded-test ','\tCase-Test\r\n']){await clear();await primary(806,value);const before=await snapshot(),result=await audit();assert.equal(result.invalidNames,1);assert.equal(result.safeToInstall,false);assert.deepEqual(await snapshot(),before)}});
  await t.test('empty ASCII whitespace does not create an association',async()=>{await clear();await primary(806,'\t\r\n');const result=await audit();assert.equal(result.associations,0);assert.equal(result.invalidNames,0)});
  const install=async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL search_path TO '+m+',public');await c.query("SELECT set_config('studiofy.evolution_legacy_schema',$1,true)",[alternative]);await c.query(fs.readFileSync(path.join(__dirname,'../database/migrations/018_evolution_instance_ownership.sql'),'utf8'));await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
  await t.test('migration rejects legacy collisions without choosing a winner',async()=>{await clear();await primary(806,'legacy-collision-test');await alternate(salons[0],'LEGACY-COLLISION-TEST');const before=await snapshot();await assert.rejects(install(),e=>e.code==='23505');assert.deepEqual(await snapshot(),before);assert.equal((await audit()).registryPresent,false)});
  await t.test('valid migration preserves sources and audit verifies global registry',async()=>{await clear();await primary(806,'valid-main-test');await alternate(salons[0],'valid-alternate-test');const before=await snapshot();await install();assert.deepEqual(await snapshot(),before);const result=await audit();assert.equal(result.ownershipConsistent,true);assert.equal(result.safeToInstall,true);assert.equal(result.associations,2)});
  await t.test('read-only audit detects a diverging legacy registry without repairing it',async()=>{await pool.query('ALTER TABLE '+m+'.evolution_instance_owners DISABLE TRIGGER USER');try{await pool.query('UPDATE '+m+'.evolution_instance_owners SET owner_id=$1 WHERE model=$2',['999','principal']);const result=await audit();assert.equal(result.inconsistent.missing,1);assert.equal(result.inconsistent.extra,1);assert.equal(result.safeToInstall,false);assert.equal((await pool.query('SELECT owner_id FROM '+m+'.evolution_instance_owners WHERE model=$1',['principal'])).rows[0].owner_id,'999')}finally{await pool.query('UPDATE '+m+'.evolution_instance_owners SET owner_id=$1 WHERE model=$2',['806','principal']);await pool.query('ALTER TABLE '+m+'.evolution_instance_owners ENABLE TRIGGER USER')}});
  await t.test('all database statements inside audit run under READ ONLY; schema injection refused',async()=>{const client=await pool.connect();let writes=0;const observed={async connect(){return {query:async config=>{const sql=typeof config==='string'?config:config.text;if(/^SELECT/i.test(sql)){const mode=(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;assert.equal(mode,'on')}if(/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql))writes++;return client.query(config)},release(){client.release()}}}};assert.equal((await auditEvolutionOwnership(observed,{mainSchema:main,legacySchema:alternative})).safeToInstall,true);assert.equal(writes,0);await assert.rejects(auditEvolutionOwnership(pool,{mainSchema:'public;DROP',legacySchema:alternative}));});
});
