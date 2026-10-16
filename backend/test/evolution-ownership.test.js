const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createEvolutionOwnershipResolver, normalizeInstanceName } = require('../services/evolutionOwnership');

const fixture = async (db, id, instance = null) => db.runAsync(`INSERT INTO assinaturas
  (id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
  VALUES ($1,'Synthetic ownership studio','Synthetic owner','11999996060','mercado_pago',5,'',$2)`, [id, instance]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(10); }
  throw Error('Ownership concurrency checkpoint not reached');
}

test('Evolution ownership: normalization and resolver fail closed without transport or fallback', async t => {
  await t.test('ASCII whitespace is trimmed, provider case preserved and absence explicit', () => {
    for (const value of [null, undefined, '', ' ', '\t\r\n']) assert.equal(normalizeInstanceName(value), null);
    assert.equal(normalizeInstanceName(' \tInstance-A_TEST\r\n'), 'Instance-A_TEST');
    assert.equal(normalizeInstanceName('a'.repeat(100)), 'a'.repeat(100));
    for (const value of ['a'.repeat(101), 'name/path', '../instance', 'x?number=123', 'x y', 'x\ny', 'ação', '\u00a0', {}, 123]) {
      assert.throws(() => normalizeInstanceName(value), { code: 'INSTANCE_INVALID' });
    }
  });
  await t.test('invalid tenant identities and schemas never reach the database', async () => {
    const db = { getAsync() { throw Error('Database must not be reached'); } };
    const resolver = createEvolutionOwnershipResolver(db, { schema: 'test_fixture' });
    for (const value of [0, -1, '6', 1.5, {}, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(resolver.resolve(value), { code: 'INSTANCE_INVALID_TENANT' });
    }
    assert.throws(() => createEvolutionOwnershipResolver(db, { schema: 'public;invalid' }), { code: 'INSTANCE_INVALID_SCHEMA' });
  });
  await t.test('missing and blank ownership never derive a name from tenant ID', async () => {
    for (const account of [undefined, { whatsapp_session: null }, { whatsapp_session: '' }, { whatsapp_session: '  ' }]) {
      const resolver = createEvolutionOwnershipResolver({ getAsync: async () => account }, { schema: 'test_fixture' });
      await assert.rejects(resolver.resolve(806), { code: 'INSTANCE_NOT_CONFIGURED' });
    }
  });
  await t.test('invalid persisted names and noncanonical legacy spelling are refused', async () => {
    for (const name of ['instance/path', ' Instance-A ']) {
      const resolver = createEvolutionOwnershipResolver({ getAsync: async () => ({ whatsapp_session: name }) }, { schema: 'test_fixture' });
      await assert.rejects(resolver.resolve(6), { code: 'INSTANCE_INVALID' });
    }
  });
  await t.test('ambiguous or crossed owners cannot resolve; database errors disclose no details', async () => {
    for (const [owners, code] of [[[], 'INSTANCE_AMBIGUOUS'], [[{ id: 6 }, { id: 806 }], 'INSTANCE_AMBIGUOUS'], [[{ id: 806 }], 'INSTANCE_OWNER_MISMATCH']]) {
      const resolver = createEvolutionOwnershipResolver({ getAsync: async () => ({ whatsapp_session: 'instance-a-test' }), allAsync: async () => owners }, { schema: 'test_fixture' });
      await assert.rejects(resolver.resolve(6), { code });
    }
    const resolver = createEvolutionOwnershipResolver({ getAsync: async () => { throw Error('private provider or database details'); } }, { schema: 'test_fixture' });
    await assert.rejects(resolver.resolve(6), error => error.code === 'INSTANCE_LOOKUP_FAILED' && !error.message.includes('private') && !error.cause);
  });
});

test('Evolution ownership: PostgreSQL exclusivity, two application pools and independent processes', { timeout: 60000 }, async t => {
  const environment = require('./helpers/postgres').testEnvironment();
  const db = require('../database'); await db.ready;
  const otherPool = new Pool(require('../database/config').connectionConfig());
  t.after(async () => { await otherPool.end(); await db.close(); await environment.cleanup(); });
  const resolver = createEvolutionOwnershipResolver(db, { schema: environment.schema });
  for (const id of [6, 806]) await fixture(db, id);
  const session = async id => (await db.getAsync('SELECT whatsapp_session FROM assinaturas WHERE id=$1', [id])).whatsapp_session;
  const assign = (id, name) => db.runAsync('UPDATE assinaturas SET whatsapp_session=$2 WHERE id=$1', [id, name]);
  const clear = async () => { await assign(6, null); await assign(806, null); };
  let network = 0;
  t.mock.method(global, 'fetch', async () => { network++; throw Error('Network forbidden'); });

  await t.test('empty database runner applied migration 018 and rerun is idempotent', async () => {
    assert.ok(await db.getAsync("SELECT name FROM schema_migrations WHERE name='018_evolution_instance_ownership.sql'"));
    await require('../database/migrate').migrate(otherPool, environment.schema);
  });
  await t.test('A/B resolve only their exact persisted instance and cannot request each other', async () => {
    await assign(6, 'Instance-A-Test'); await assign(806, 'instance-b-test');
    assert.deepEqual(await resolver.resolve(6), { assinaturaId: 6, instanceName: 'Instance-A-Test' });
    assert.deepEqual(await resolver.resolve(806), { assinaturaId: 806, instanceName: 'instance-b-test' });
    await assert.rejects(resolver.resolve(6, { expectedInstance: 'instance-b-test' }), { code: 'INSTANCE_OWNER_MISMATCH' });
    await assert.rejects(resolver.resolve(806, { expectedInstance: 'Instance-A-Test' }), { code: 'INSTANCE_OWNER_MISMATCH' });
  });
  await t.test('case variants and outer spaces reserve the same ownership key', async () => {
    await clear(); await assign(6, ' \tInstance-X\r\n'); assert.equal(await session(6), 'Instance-X');
    for (const name of ['instance-x', 'INSTANCE-X', ' instance-X ']) {
      await assert.rejects(assign(806, name), error => error.code === '23505');
      assert.equal(await session(806), null);
    }
  });
  await t.test('NULL, blank, whitespace never reserve; internal whitespace and unsafe names fail', async () => {
    for (const name of [null, '', ' ', '\t\r\n']) {
      await assign(6, name); await assign(806, name); assert.equal(await session(6), null); assert.equal(await session(806), null);
    }
    for (const name of ['bad/name', 'bad name', 'bad\nname', 'x'.repeat(101), '\u00a0']) {
      await assert.rejects(assign(6, name), error => error.code === '23514');
    }
    await assert.rejects(resolver.resolve(6), { code: 'INSTANCE_NOT_CONFIGURED' });
    await assert.rejects(resolver.resolve(999999), { code: 'INSTANCE_NOT_CONFIGURED' });
  });
  await t.test('legitimate switch, release and reassignment are explicit and transactional', async () => {
    await assign(6, 'instance-a-test'); await assign(806, 'instance-b-test');
    await assign(6, 'instance-c-test'); await assign(806, 'instance-a-test');
    await assert.rejects(assign(6, 'instance-a-test'), error => error.code === '23505');
    await assign(806, null); await assign(6, 'instance-a-test');
    assert.equal((await resolver.resolve(6)).instanceName, 'instance-a-test');
    await assert.rejects(resolver.resolve(806), { code: 'INSTANCE_NOT_CONFIGURED' });
  });
  await t.test('rollback restores previous ownership and releases an uncommitted reservation', async () => {
    await clear(); await assign(6, 'instance-a-test');
    await assert.rejects(db.transaction(async c => {
      await c.runAsync("UPDATE assinaturas SET whatsapp_session='rollback-test' WHERE id=6");
      throw Error('rollback probe');
    }), /rollback probe/);
    assert.equal(await session(6), 'instance-a-test'); await assign(806, 'rollback-test');
  });
  await t.test('two transactions/pools contend; only one owns the normalized instance', async () => {
    await clear(); const a = await db.pool.connect(), b = await otherPool.connect();
    try {
      await a.query('BEGIN'); await b.query('BEGIN');
      await a.query("UPDATE assinaturas SET whatsapp_session='concurrent-test' WHERE id=6");
      const second = b.query("UPDATE assinaturas SET whatsapp_session=' CONCURRENT-TEST ' WHERE id=806");
      const rejected = assert.rejects(second, error => error.code === '23505');
      await until(async () => (await db.getAsync("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%CONCURRENT-TEST%'")).n > 0);
      await a.query('COMMIT'); await rejected; await b.query('ROLLBACK');
      assert.equal(await session(6), 'concurrent-test'); assert.equal(await session(806), null);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
  });
  await t.test('independent Node processes cannot acquire the same instance', async () => {
    await clear();
    const code = `const {Pool}=require('pg');const p=new Pool(require('./database/config').connectionConfig());
      (async()=>{const c=await p.connect();await c.query('BEGIN');process.send('ready');await new Promise(r=>process.once('message',r));
      try{await c.query('UPDATE assinaturas SET whatsapp_session=$2 WHERE id=$1',[Number(process.argv[1]),'process-owner-test']);await c.query('COMMIT');process.send('owned');}
      catch(e){await c.query('ROLLBACK');if(e.code!=='23505')throw e;process.send('collision');}finally{c.release();await p.end();process.disconnect();}})().catch(()=>{process.exitCode=1;process.disconnect();});`;
    const children = [6, 806].map(id => {
      const child = spawn(process.execPath, ['-e', code, String(id)], { cwd: path.join(__dirname, '..'), env: process.env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let result;
      const ready = new Promise(resolve => child.once('message', resolve));
      const ended = new Promise((resolve, reject) => { child.once('error', reject); child.on('message', msg => { if (msg !== 'ready') result = msg; }); child.once('exit', code => code === 0 ? resolve(result) : reject(Error('Ownership process failed'))); });
      return { child, ready, ended };
    });
    await Promise.all(children.map(c => c.ready)); for (const c of children) c.child.send('start');
    assert.deepEqual((await Promise.all(children.map(c => c.ended))).sort(), ['collision', 'owned']);
    assert.equal((await db.getAsync("SELECT count(*)::int n FROM assinaturas WHERE whatsapp_session='process-owner-test'")).n, 1);
  });
  await t.test('configured schema prevents search_path/temporary table substitution', async () => {
    await clear(); await assign(6, 'instance-a-test');
    const c = await otherPool.connect();
    try {
      await c.query('CREATE TEMP TABLE assinaturas(id bigint,whatsapp_session text)');
      await c.query("INSERT INTO pg_temp.assinaturas VALUES (6,'instance-b-test')"); await c.query('SET search_path TO pg_temp,public');
      const scoped = createEvolutionOwnershipResolver({ getAsync: async (...a) => (await c.query(...a)).rows[0], allAsync: async (...a) => (await c.query(...a)).rows }, { schema: environment.schema });
      assert.equal((await scoped.resolve(6)).instanceName, 'instance-a-test');
    } finally { await c.query('DROP TABLE pg_temp.assinaturas'); await c.query(`SET search_path TO "${environment.schema}",public`); c.release(); }
  });
  await t.test('no provider transport is called', () => assert.equal(network, 0));
});

test('Evolution ownership: real migration runner refuses legacy collisions without choosing an owner', { timeout: 60000 }, async t => {
  const directory = path.join(__dirname, '../database/migrations');
  const { migrate } = require('../database/migrate');
  async function legacy(rows, run) {
    const schema = 'test_' + crypto.randomUUID().replaceAll('-', '');
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
    const c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query(`CREATE SCHEMA "${schema}"`); await c.query(`SET LOCAL search_path TO "${schema}",public`);
      await c.query('CREATE TABLE schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)');
      for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.sql') && n < '018').sort()) {
        const sql = fs.readFileSync(path.join(directory, name), 'utf8'); await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name,checksum) VALUES ($1,$2)', [name, crypto.createHash('sha256').update(sql).digest('hex')]);
      }
      for (const [id, value] of rows) await c.query(`INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
        VALUES ($1,'Legacy synthetic','Owner','11999996060','mercado_pago',5,'',$2)`, [id, value]);
      await c.query('COMMIT');
      await run(pool, schema);
    } finally { await c.query('ROLLBACK'); c.release(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); }
  }
  for (const values of [['instance-x-test', 'instance-x-test'], ['Instance-X-Test', ' instance-x-test ']]) await t.test('legacy duplicate exact/case/space fails atomically: ' + JSON.stringify(values), async () => {
    await legacy([[6, values[0]], [806, values[1]]], async (pool, schema) => {
      await assert.rejects(migrate(pool, schema), error => error.code === '23505' && /manual legacy regularization/.test(error.message));
      assert.deepEqual((await pool.query('SELECT whatsapp_session FROM assinaturas ORDER BY id')).rows.map(r => r.whatsapp_session), values);
      assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name LIKE '018%'")).rows[0].n, 0);
      assert.equal((await pool.query("SELECT to_regprocedure($1) present", [schema + '.studiofy_evolution_instance_key(text)'])).rows[0].present, null);
    });
  });
  await t.test('explicit legacy regularization permits upgrade without changing the chosen surviving name', async () => {
    await legacy([[6, 'Instance-X-Test'], [806, 'instance-x-test']], async (pool, schema) => {
      await assert.rejects(migrate(pool, schema), error => error.code === '23505');
      // The test explicitly authorizes release; the migration never chooses a winner.
      await pool.query('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=806'); await migrate(pool, schema);
      assert.deepEqual((await pool.query('SELECT whatsapp_session FROM assinaturas ORDER BY id')).rows, [{ whatsapp_session: 'Instance-X-Test' }, { whatsapp_session: null }]);
      await migrate(pool, schema);
    });
  });
  for (const value of ['bad/path', ' Instance-X-Test ']) await t.test('invalid legacy association fails without silently renaming: ' + value, async () => {
    await legacy([[6, value]], async (pool, schema) => {
      await assert.rejects(migrate(pool, schema), error => error.code === '23514');
      assert.equal((await pool.query('SELECT whatsapp_session FROM assinaturas WHERE id=6')).rows[0].whatsapp_session, value);
    });
  });
  await t.test('valid names, NULL and legacy blanks survive upgrade unchanged', async () => {
    const values = ['Instance-A-Test', 'instance-b-test', null, '', ' \t\r\n'];
    await legacy(values.map((value, i) => [806 + i, value]), async (pool, schema) => {
      await migrate(pool, schema);
      assert.deepEqual((await pool.query('SELECT whatsapp_session FROM assinaturas ORDER BY id')).rows.map(r => r.whatsapp_session), values);
    });
  });
});
