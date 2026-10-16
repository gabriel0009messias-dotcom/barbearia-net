const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');
const { createEvolutionOwnershipResolver } = require('../services/evolutionOwnership');
const quote = value => '"' + value + '"';
const directory = path.join(__dirname, '../database/migrations');
const legacyDirectory = path.join(__dirname, '../src/database/migrations');
const schemaName = () => 'test_' + randomUUID().replaceAll('-', '');
const principalFixture = (c, schema, id, name = null) => c.query(`INSERT INTO ${quote(schema)}.assinaturas
 (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
 VALUES ($1,'Ownership test','Owner','11999996060','mercado_pago',5,'',$2)`, [id, name]);
const salonFixture = (c, schema, id) => c.query(`INSERT INTO ${quote(schema)}.salons(id,name,slug,owner_name,email)
 VALUES ($1::uuid,'Alternative test',$1::uuid::text,'Owner',$1::uuid::text || '@example.test')`, [id]);
async function legacySchema(c, schema) {
 await c.query(`CREATE SCHEMA ${quote(schema)}`); await c.query(`SET search_path TO ${quote(schema)},public`);
 for (const name of fs.readdirSync(legacyDirectory).filter(n => n.endsWith('.sql')).sort()) await c.query(fs.readFileSync(path.join(legacyDirectory, name), 'utf8'));
}
async function principalSchema(c, schema) {
 await c.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`); await c.query(`SET search_path TO ${quote(schema)},public`);
 await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
 for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.sql') && n < '018').sort()) {
  const sql = fs.readFileSync(path.join(directory, name), 'utf8'); await c.query(sql);
  await c.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
 }
}
async function transaction(pool, fn) {
 const c = await pool.connect();
 try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
 catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}

test('global Evolution ownership: both models, actual alternative runner and fenced principal resolver', { timeout: 90000 }, async t => {
 const main = schemaName(), alternative = schemaName();
 process.env.DATABASE_SCHEMA = main; process.env.LEGACY_DATABASE_SCHEMA = alternative;
 const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
 const { runMigrations } = require('../src/database/migrate');
 const alternativePool = require('../src/database/pool').pool;
 t.after(async () => { await alternativePool.end(); await pool.query(`DROP SCHEMA IF EXISTS ${quote(main)} CASCADE`); await pool.query(`DROP SCHEMA IF EXISTS ${quote(alternative)} CASCADE`); await pool.end(); });
 await migrate(pool, main); await runMigrations({ targetPool: pool, mainSchema: main, legacySchema: alternative });
 for (const id of [6, 806]) await principalFixture(pool, main, id);
 const salons = [randomUUID(), randomUUID()];
 for (const id of salons) { await salonFixture(pool, alternative, id); await pool.query(`INSERT INTO ${quote(alternative)}.whatsapp_sessions(salon_id) VALUES ($1)`, [id]); }
 const primary = (id, name, c = pool) => c.query(`UPDATE ${quote(main)}.assinaturas SET whatsapp_session=$2 WHERE id=$1`, [id, name]);
 const alternate = (id, name, c = pool) => c.query(`UPDATE ${quote(alternative)}.whatsapp_sessions SET instance_name=$2 WHERE salon_id=$1`, [id, name]);
 const clear = async () => { await pool.query(`UPDATE ${quote(main)}.assinaturas SET whatsapp_session=NULL`); await pool.query(`UPDATE ${quote(alternative)}.whatsapp_sessions SET instance_name=NULL`); };
 const registry = async () => (await pool.query(`SELECT * FROM ${quote(main)}.evolution_instance_owners ORDER BY instance_key`)).rows;
 const db = { getAsync: async (...args) => (await pool.query(...args)).rows[0], allAsync: async (...args) => (await pool.query(...args)).rows };
 const resolver = createEvolutionOwnershipResolver(db, { schema: main });
 let network = 0; t.mock.method(global, 'fetch', async () => { network++; throw Error('No provider network allowed'); });

 await t.test('principal/principal, alternative/alternative and cross-model names share one unique key', async () => {
  for (const [one, two] of [[name => primary(6, name), name => primary(806, name)], [name => alternate(salons[0], name), name => alternate(salons[1], name)], [name => primary(6, name), name => alternate(salons[0], name)], [name => alternate(salons[0], name), name => primary(6, name)]]) {
   await clear(); await one('Instance-X-Test');
   for (const name of ['instance-x-test', 'INSTANCE-X-TEST', ' \tinstance-x-test\r\n']) await assert.rejects(two(name), error => error.code === '23505');
   assert.equal((await registry()).length, 1); assert.equal((await registry())[0].instance_name, 'Instance-X-Test');
  }
 });
 await t.test('NULL/blanks normalize consistently; malformed names do not reserve ownership in either model', async () => {
  await clear();
  for (const name of [null, '', ' ', '\t\r\n']) { await primary(6, name); await alternate(salons[0], name); assert.equal((await registry()).length, 0); }
  for (const name of ['name/path', 'name?token=x', 'x'.repeat(101), 'na me', '\u00a0']) {
   await assert.rejects(primary(6, name), error => error.code === '23514'); await assert.rejects(alternate(salons[0], name), error => error.code === '23514');
  }
 });
 await t.test('the principal resolver validates global principal ownership and never selects the alternative model', async () => {
  await clear(); await primary(6, 'instance-a-test'); await primary(806, 'instance-b-test'); await alternate(salons[0], 'instance-legacy-test');
  assert.deepEqual(await resolver.resolve(6), { assinaturaId: 6, instanceName: 'instance-a-test' });
  assert.deepEqual(await resolver.resolve(806), { assinaturaId: 806, instanceName: 'instance-b-test' });
  await assert.rejects(resolver.resolve(6, { expectedInstance: 'instance-legacy-test' }), { code: 'INSTANCE_OWNER_MISMATCH' });
  const untrustedFirstRead = createEvolutionOwnershipResolver({ ...db, getAsync: async () => ({ whatsapp_session: 'instance-legacy-test' }) }, { schema: main });
  await assert.rejects(untrustedFirstRead.resolve(6), { code: 'INSTANCE_OWNER_MISMATCH' });
  await assert.rejects(resolver.resolve(salons[0]), { code: 'INSTANCE_INVALID_TENANT' });
  await primary(806, null); await assert.rejects(resolver.resolve(806), { code: 'INSTANCE_NOT_CONFIGURED' });
 });
 for (const pair of ['principal/principal', 'alternative/alternative', 'principal/alternative']) await t.test('two PostgreSQL sessions contend atomically: ' + pair, async () => {
  await clear(); const a = await pool.connect(), b = await pool.connect();
  const first = pair.startsWith('principal') ? (name, c) => primary(6, name, c) : (name, c) => alternate(salons[0], name, c);
  const second = pair.endsWith('principal') ? (name, c) => primary(806, name, c) : (name, c) => alternate(salons[1], name, c);
  try {
   await a.query('BEGIN'); await b.query('BEGIN'); await first('concurrent-global-test', a);
   const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const attempt = second(' CONCURRENT-GLOBAL-TEST ', b); const rejected = assert.rejects(attempt, error => error.code === '23505');
   for (let i = 0; i < 300; i++) { if ((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].wait_event_type === 'Lock') break; await new Promise(r => setTimeout(r, 10)); if (i === 299) throw Error('No database contention observed'); }
   await a.query('COMMIT'); await rejected; await b.query('ROLLBACK'); assert.equal((await registry()).length, 1);
  } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
 });
 await t.test('REPEATABLE READ cannot bypass cross-model uniqueness with an older snapshot', async () => {
  await clear(); const a=await pool.connect(),b=await pool.connect();
  try {
   await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   await b.query('SELECT * FROM '+quote(main)+'.evolution_instance_owners');
   await primary(6,'repeatable-read-test',a);await a.query('COMMIT');
   await assert.rejects(alternate(salons[0],'REPEATABLE-READ-TEST',b),error=>['23505','40001'].includes(error.code));
   await b.query('ROLLBACK');assert.equal((await registry()).length,1);
  }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
 });
 await t.test('two independent Node processes contend across models with one global winner', async () => {
  await clear();
  const queries = [`UPDATE ${quote(main)}.assinaturas SET whatsapp_session=$1 WHERE id=6`, `UPDATE ${quote(alternative)}.whatsapp_sessions SET instance_name=$1 WHERE salon_id='${salons[0]}'`];
  const processes = queries.map(sql => {
   const code = `const {Pool}=require('pg');const p=new Pool({connectionString:process.env.TEST_DATABASE_URL});(async()=>{const c=await p.connect();await c.query('BEGIN');process.send('ready');await new Promise(r=>process.once('message',r));try{await c.query(${JSON.stringify(sql)},['process-global-test']);await c.query('COMMIT');process.send('owned');}catch(e){await c.query('ROLLBACK');if(e.code!=='23505')throw e;process.send('collision');}finally{c.release();await p.end();process.disconnect();}})().catch(()=>{process.exitCode=1;process.disconnect();});`;
   const child = spawn(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
   t.after(() => { if (child.exitCode === null) child.kill(); }); let outcome;
   const ready = new Promise(r => child.once('message', r));
   const ended = new Promise((resolve, reject) => { child.once('error', reject); child.on('message', m => { if (m !== 'ready') outcome = m; }); child.once('exit', code => code === 0 ? resolve(outcome) : reject(Error('Global ownership child failed'))); });
   return { child, ready, ended };
  });
  await Promise.all(processes.map(p => p.ready)); for (const p of processes) p.child.send('start');
  assert.deepEqual((await Promise.all(processes.map(p => p.ended))).sort(), ['collision','owned']); assert.equal((await registry()).length, 1);
 });
 await t.test('rollback of release/acquisition/transfer preserves both sources and the registry', async () => {
  await clear(); await primary(6, 'instance-transfer-test'); const before = await registry();
  await assert.rejects(transaction(pool, async c => { await primary(6, null, c); await alternate(salons[0], 'instance-transfer-test', c); throw Error('rollback transfer'); }), /rollback transfer/);
  assert.deepEqual(await registry(), before); assert.equal((await resolver.resolve(6)).instanceName, 'instance-transfer-test');
  await assert.rejects(transaction(pool, async c => { await alternate(salons[0], 'new-reservation-test', c); throw Error('rollback acquisition'); }), /rollback acquisition/);
  assert.deepEqual(await registry(), before);
  await transaction(pool, async c => { await primary(6, null, c); await alternate(salons[0], 'instance-transfer-test', c); });
  assert.equal((await registry())[0].model, 'alternative'); await assert.rejects(resolver.resolve(6), { code: 'INSTANCE_NOT_CONFIGURED' });
  await alternate(salons[0], null); await primary(806, 'instance-transfer-test'); assert.equal((await resolver.resolve(806)).instanceName, 'instance-transfer-test');
 });
 await t.test('switching to an occupied name fails without losing the previous instance', async () => {
  await clear(); await primary(6, 'instance-old-test'); await alternate(salons[0], 'instance-busy-test'); const before = await registry();
  await assert.rejects(primary(6, 'instance-busy-test'), error => error.code === '23505'); assert.deepEqual(await registry(), before);
  await primary(6, 'instance-new-test'); await alternate(salons[1], 'instance-old-test'); assert.equal((await registry()).length, 3);
 });
 await t.test('actual legacy repository UPSERT preserves status and supports changing/releasing its instance', async () => {
  await clear(); const repository = require('../src/repositories/whatsappSessionRepository');
  await repository.upsertStatus(salons[0], { instanceName: 'legacy-upsert-test', status: 'CONNECTED' });
  await repository.upsertStatus(salons[0], { instanceName: 'legacy-upsert-test', status: 'DISCONNECTED' });
  await repository.upsertStatus(salons[0], { instanceName: 'legacy-upsert-new-test', status: 'CONNECTED' });
  assert.equal((await registry())[0].instance_name, 'legacy-upsert-new-test');
  await primary(6, 'main-upsert-test'); await assert.rejects(repository.upsertStatus(salons[0], { instanceName: 'main-upsert-test', status: 'CONNECTED' }), error => error.code === '23505');
  assert.equal((await repository.findBySalonId(salons[0])).instance_name, 'legacy-upsert-new-test');
  await repository.upsertStatus(salons[0], { status: 'DISCONNECTED' }); assert.equal((await registry()).length, 1);
 });
 await t.test('direct registry deletion, forgery, owner substitution and TRUNCATE fail closed', async () => {
  await clear(); await primary(6, 'registry-guard-test'); const before = await registry();
  for (const sql of [`DELETE FROM ${quote(main)}.evolution_instance_owners`, `UPDATE ${quote(main)}.evolution_instance_owners SET owner_id='806'`,
   `INSERT INTO ${quote(main)}.evolution_instance_owners VALUES ('forged-test','forged-test','principal','${main}','806')`]) {
   await assert.rejects(transaction(pool, c => c.query(sql)), error => error.code === '23514'); assert.deepEqual(await registry(), before);
  }
  await assert.rejects(pool.query(`TRUNCATE ${quote(main)}.evolution_instance_owners`), error => error.code === '23514');
 });
 await t.test('session deletion and source TRUNCATE release only their legitimate ownerships', async () => {
  await clear(); await primary(6, 'main-survives-test'); await alternate(salons[0], 'legacy-release-test');
  await pool.query(`DELETE FROM ${quote(alternative)}.whatsapp_sessions WHERE salon_id=$1`, [salons[0]]); await primary(806, 'legacy-release-test');
  await pool.query(`INSERT INTO ${quote(alternative)}.whatsapp_sessions(salon_id,instance_name) VALUES ($1,'truncate-release-test')`, [salons[0]]);
  await pool.query(`TRUNCATE ${quote(alternative)}.whatsapp_sessions`); assert.equal((await registry()).length, 2);
  await primary(806, 'truncate-release-test');
 });
 await t.test('alternative rerun and then main rerun preserve ownership without side effects', async () => {
  const before = await registry(); await runMigrations({ targetPool: pool, mainSchema: main, legacySchema: alternative }); await migrate(pool, main); assert.deepEqual(await registry(), before); assert.equal(network, 0);
 });
});

test('global Evolution ownership: upgrade matrices and legacy collisions are atomic and fail closed', { timeout: 90000 }, async t => {
 const { runMigrations } = require('../src/database/migrate');
 async function fixture({ main: hasMain, alternative: hasAlternative, mainNames = [], alternativeNames = [] }, verify) {
  const main = schemaName(), alternative = schemaName(); process.env.DATABASE_SCHEMA = main; process.env.LEGACY_DATABASE_SCHEMA = alternative;
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }); const c = await pool.connect();
  try {
   if (hasMain) { await principalSchema(c, main); for (let i=0;i<mainNames.length;i++) await principalFixture(c,main,806+i,mainNames[i]); }
   if (hasAlternative) { await legacySchema(c,alternative); for (const name of alternativeNames) { const id=randomUUID();await salonFixture(c,alternative,id);await c.query(`INSERT INTO ${quote(alternative)}.whatsapp_sessions(salon_id,instance_name) VALUES ($1,$2)`,[id,name]); } }
   const apply = () => hasMain ? migrate(pool,main) : runMigrations({targetPool:pool,mainSchema:main,legacySchema:alternative});
   await verify({pool,c,main,alternative,apply});
  } finally { c.release(); await pool.query(`DROP SCHEMA IF EXISTS ${quote(main)} CASCADE`); await pool.query(`DROP SCHEMA IF EXISTS ${quote(alternative)} CASCADE`); await pool.end(); }
 }
 for (const [label,config,count] of [
  ['empty',{main:true,alternative:false},0],
  ['principal only',{main:true,alternative:false,mainNames:['Instance-Main-Test']},1],
  ['alternative only',{main:false,alternative:true,alternativeNames:['Instance-Legacy-Test']},1],
  ['both without collision',{main:true,alternative:true,mainNames:['Instance-Main-Test'],alternativeNames:['Instance-Legacy-Test']},2],
 ]) await t.test(label+' upgrades while preserving valid names',async()=>{
  await fixture(config,async({pool,main,apply})=>{await apply();assert.equal((await pool.query(`SELECT count(*)::int n FROM ${quote(main)}.evolution_instance_owners`)).rows[0].n,count);});
 });
 for (const [label,config] of [
  ['principal/principal',{main:true,alternative:false,mainNames:['Instance-X-Test','instance-x-test']}],
  ['alternative/alternative',{main:false,alternative:true,alternativeNames:['Instance-X-Test',' instance-x-test ']}],
  ['principal/alternative',{main:true,alternative:true,mainNames:['Instance-X-Test'],alternativeNames:['instance-x-test']}],
 ]) await t.test(label+' collision chooses no winner and changes no source',async()=>{
  await fixture(config,async({pool,main,alternative,apply})=>{
   const snapshot=async()=>({main:config.main?(await pool.query(`SELECT whatsapp_session FROM ${quote(main)}.assinaturas ORDER BY id`)).rows:[],alternative:config.alternative?(await pool.query(`SELECT salon_id,instance_name FROM ${quote(alternative)}.whatsapp_sessions ORDER BY salon_id`)).rows:[]});
   const before=await snapshot();await assert.rejects(apply(),error=>error.code==='23505'&&/manual legacy regularization/.test(error.message));assert.deepEqual(await snapshot(),before);assert.equal((await pool.query('SELECT to_regclass($1) present',[main+'.evolution_instance_owners'])).rows[0].present,null);
  });
 });
 await t.test('alternative-first then principal installation shares the existing ownership namespace',async()=>{
  await fixture({main:false,alternative:true,alternativeNames:['late-principal-test']},async({pool,c,main,alternative,apply})=>{
   await apply();const before=(await pool.query(`SELECT * FROM ${quote(main)}.evolution_instance_owners`)).rows;
   await migrate(pool,main);await assert.rejects(principalFixture(c,main,806,'late-principal-test'),error=>error.code==='23505');assert.deepEqual((await pool.query(`SELECT * FROM ${quote(main)}.evolution_instance_owners`)).rows,before);
  });
 });
 await t.test('late principal backfill preserves an existing alternative ownership and registers its own rows',async()=>{
  await fixture({main:false,alternative:true,alternativeNames:['existing-alternative-test']},async({pool,c,main,apply})=>{
   await apply();await principalSchema(c,main);await principalFixture(c,main,806,'late-main-backfill-test');
   await migrate(pool,main);const owners=(await pool.query('SELECT model FROM '+quote(main)+'.evolution_instance_owners ORDER BY model')).rows;
   assert.deepEqual(owners,[{model:'alternative'},{model:'principal'}]);
  });
 });
 await t.test('manual explicit regularization allows the same migration to complete',async()=>{
  await fixture({main:true,alternative:true,mainNames:['regularize-test'],alternativeNames:['REGULARIZE-TEST']},async({pool,main,alternative,apply})=>{
   await assert.rejects(apply(),error=>error.code==='23505');await pool.query(`UPDATE ${quote(alternative)}.whatsapp_sessions SET instance_name=NULL`);await apply();assert.equal((await pool.query(`SELECT model FROM ${quote(main)}.evolution_instance_owners`)).rows[0].model,'principal');
  });
 });
 await t.test('a source already bound to another installation is not silently reassigned',async()=>{
  await fixture({main:false,alternative:true,alternativeNames:['binding-test']},async({pool,c,main,alternative,apply})=>{
   await apply();const second=schemaName();try{await principalSchema(c,second);await assert.rejects(migrate(pool,second),error=>error.code==='23514'&&/another ownership installation/.test(error.message));assert.equal((await pool.query(`SELECT count(*)::int n FROM ${quote(main)}.evolution_instance_owners`)).rows[0].n,1);}finally{await pool.query(`DROP SCHEMA IF EXISTS ${quote(second)} CASCADE`);}
  });
 });
});
