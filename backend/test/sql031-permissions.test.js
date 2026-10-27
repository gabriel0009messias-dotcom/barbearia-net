const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../services/supervision/sql031Permissions');
const { localTestUrl } = require('./helpers/sql031PermissionFixture');
const schema = 'test_' + 'a'.repeat(32), database = 'test_permissions';
function fixture(profile = 'EXECUTOR') {
  const tables = profile === 'EXECUTOR' ? p.executorTables : p.issuerTables;
  const apis = profile === 'EXECUTOR' ? p.executorFunctions : p.issuerFunctions;
  return { identity: { login: 'test_executor', effective: 'test_executor', database, schema,
    ...Object.fromEntries(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'membership',
      'ddl_schema', 'ddl_database', 'ddl_temp', 'owns_database', 'owns_relation', 'owns_function', 'owns_type'].map(k => [k, false])) },
    relations: Object.entries(tables).map(([name, privileges]) => ({ schema, name, privileges: [...privileges], table_privileges: [...privileges], grantable: false })),
    functions: apis.map(signature => ({ schema, name: signature.split('(')[0], types: signature.slice(signature.indexOf('(') + 1, -1), executable: true, grantable: false })),
    sequences: [], excessAcl: [] };
}
const options = { profile: 'EXECUTOR', expectedLogin: 'test_executor', schema, database };
test('explicit profiles require distinct canonical login names', () => {
  const names = { migratorLogin: 'test_migrator', issuerLogin: 'test_issuer', executorLogin: 'test_executor' };
  assert.equal(p.distinctLogins(names).length, 3);
  for (const change of [{ executorLogin: names.issuerLogin }, { executorLogin: names.migratorLogin }, { issuerLogin: names.migratorLogin }])
    assert.throws(() => p.distinctLogins({ ...names, ...change }), { code: 'SQL031_INPUT_INVALID' });
});
test('least privilege positive executor and issuer profiles', () => {
  assert.equal(p.assertProfile(fixture(), options).profile, 'EXECUTOR');
  assert.equal(p.assertProfile(fixture('ISSUER'), { ...options, profile: 'ISSUER' }).profile, 'ISSUER');
});
for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'membership',
  'ddl_schema', 'ddl_database', 'ddl_temp', 'owns_database', 'owns_relation', 'owns_function', 'owns_type']) {
  test('executor rejects effective ' + flag + ', including missing catalog evidence', () => {
    for (const value of [true, undefined, null]) {
      const f = fixture(); f.identity[flag] = value;
      assert.throws(() => p.assertProfile(f, options), { code: 'SQL031_INPUT_INVALID' });
    }
  });
}
test('SET ROLE, wrong database/schema and wrong login are not identities', () => {
  for (const change of [{ effective: 'other' }, { login: 'other' }, { schema: 'public' }, { database: 'production' }]) {
    const f = fixture(); Object.assign(f.identity, change);
    assert.throws(() => p.assertProfile(f, options), { code: 'SQL031_INPUT_INVALID' });
  }
});
test('closure, STOP, ledger DML, column privilege, foreign objects and grant options fail closed', () => {
  const mutations = [
    f => f.functions.push({ schema, name: 'studiofy_accept_executor_closure', types: 'jsonb', executable: true, grantable: false }),
    f => f.functions.push({ schema, name: 'studiofy_accept_execution_stop', types: 'jsonb', executable: true, grantable: false }),
    f => f.relations.push({ schema, name: p.ledgers[0], privileges: ['INSERT'], grantable: false }),
    f => f.relations.push({ schema: 'public', name: 'foreign', privileges: ['UPDATE'], grantable: false }),
    f => { f.relations[0].grantable = true; },
    f => { f.functions[0].grantable = true; },
    f => f.sequences.push({ schema, table_name: 'whatsapp_messages', usage: true, readable: false, writable: true, grantable: false }),
    f => { f.relations[0].table_privileges = []; },
    f => { f.functions[0].executable = false; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => p.assertProfile(f, options), { code: 'SQL031_INPUT_INVALID' }); }
});
test('issuer rejects operational writes and transport-related SQL capability', () => {
  const f = fixture('ISSUER'); f.relations.push({ schema, name: 'whatsapp_messages', privileges: ['INSERT'], grantable: false });
  assert.throws(() => p.assertProfile(f, { ...options, profile: 'ISSUER' }), { code: 'SQL031_INPUT_INVALID' });
});
test('fixture rejects nonlocal/non-test endpoints before opening PostgreSQL', () => {
  for (const raw of ['postgresql://x@remote.invalid/test_a', 'postgresql://x@127.0.0.1/production',
    'postgresql://x@127.0.0.1/test_a?host=remote.invalid', 'https://localhost/test_a']) assert.throws(() => localTestUrl(raw));
  for (const host of ['localhost', '127.0.0.1', '[::1]']) assert.ok(localTestUrl('postgresql://x@' + host + '/test_a'));
});
test('H1: absent ACL evidence and excess rights fail closed in every object class/namespace', () => {
  const missing = fixture(); delete missing.excessAcl;
  assert.throws(() => p.assertProfile(missing, options), { code: 'SQL031_INPUT_INVALID' });
  for (const schema of ['pg_catalog', 'information_schema', 'pg_untrusted', 'other'])
    for (const kind of ['routine', 'relation', 'column', 'sequence', 'type', 'schema']) {
      const f = fixture(); f.excessAcl.push({ schema, kind, privilege_type: 'EXCESS', is_grantable: false });
      assert.throws(() => p.assertProfile(f, options), { code: 'SQL031_INPUT_INVALID' });
    }
});
for (const kind of ['database', 'tablespace', 'trusted_language', 'untrusted_language', 'fdw', 'foreign_server',
  'user_mapping', 'large_object', 'large_object_allocator', 'parameter', 'extension', 'publication', 'subscription']) {
  test('H2B: rejects ' + kind + ' excess capability, ownership and delegation', () => {
    for (const privilege_type of ['EXCESS', 'OWNERSHIP', 'GRANT OPTION']) {
      const f = fixture(); f.excessAcl.push({ kind, privilege_type, is_grantable: privilege_type === 'GRANT OPTION' });
      assert.throws(() => p.assertProfile(f, options), { code: 'SQL031_INPUT_INVALID' });
    }
  });
}

// Exercise the real fixture hook with in-memory pools, never PostgreSQL.
function cleanupHarness(filename, faults = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const actualRequire = require('node:module').createRequire(filename);
  const pools = [], operations = []; let hook, autoConfReads = 0;
  class FakePool extends EventEmitter {
    constructor(config) {
      super(); const url = new URL(config.connectionString);
      this.kind = ['migrator', 'issuer', 'executor'].find(k => url.username.startsWith('test_' + k + '_')) ||
        (url.pathname.startsWith('/test_sql031_') ? 'catalog_admin' : 'admin');
      pools.push(this);
    }
    async query(sql) {
      operations.push(sql.startsWith('DROP ') ? sql.split(' ').slice(0, 2).join('_') : 'QUERY');
      if (sql.startsWith("SELECT current_setting('data_directory')")) return { rows: [{ directory: '/tmp/test_h3', id: '123' }] };
      if (sql === 'SELECT datname FROM pg_database') return { rows: [{ datname: 'test_fake' }] };
      const phase = sql.startsWith('DROP DATABASE') ? 'DATABASE_DROP' : sql.startsWith('DROP ROLE') ? 'ROLE_DROP' :
        sql.startsWith('SELECT 1 FROM pg_database') ? 'DATABASE_ABSENCE_CHECK' :
        sql.startsWith('SELECT 1 FROM pg_roles') ? 'ROLE_ABSENCE_CHECK' : null;
      if (faults.phase === phase && phase) {
        if (phase.endsWith('ABSENCE_CHECK')) return { rows: [{}], rowCount: 1 };
        throw faults.error;
      }
      return { rows: [], rowCount: 0 };
    }
    async end() {
      operations.push('END_' + this.kind);
      if (faults.endErrors?.[this.kind]) throw faults.endErrors[this.kind];
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, URL, Buffer, AggregateError,
    process: { env: { TEST_DATABASE_URL: 'postgresql://test_admin:synthetic-base-password@127.0.0.1/test_fake',
      SQL031_ISOLATED_CLUSTER_DIR: '/tmp/test_h3', SQL031_ISOLATED_CLUSTER_ID: '123' } },
    __dirname: require('node:path').dirname(filename),
    require(name) {
      if (name === 'pg') return { Pool: FakePool };
      if (name === 'node:fs') return { readFileSync(file) {
        if (file.endsWith('PG_VERSION')) return '18';
        autoConfReads++; return Buffer.from(faults.phase === 'AUTO_CONF_HASH_CHECK' && autoConfReads > 1 ? 'changed' : 'baseline');
      } };
      if (name === '../../database/migrate') return { migrate: async () => {} };
      return actualRequire(name);
    },
  }, { filename });
  return { pools, operations,
    prepare: () => module.exports.permissionFixture({ after(fn) { hook = fn; } }), cleanup: () => hook() };
}
const cleanupHelper = require('node:path').join(__dirname, 'helpers/sql031PermissionFixture.js');

test('H3: cleanup preserves every original failure and emits only safe phase metadata', async () => {
  const secrets = ['synthetic-password-97', 'synthetic-token-98', 'synthetic-api-key-99', 'synthetic-client-96'];
  const sensitive = 'postgresql://user:' + secrets[0] + '@db.test/private Authorization: Bearer ' + secrets[1] +
    ' Cookie: ' + secrets[2] + ' customer=' + secrets[3];
  const cause = new Error(sensitive), first = Object.assign(new Error(sensitive, { cause }), { code: '53300' });
  const second = Object.assign(new TypeError(sensitive), { code: '40001' });
  const drop = Object.assign(new Error(sensitive), { code: '42501' });
  const asynchronous = Object.assign(new Error(sensitive), { code: '57P01', name: sensitive });
  const h = cleanupHarness(cleanupHelper, { endErrors: { catalog_admin: first, issuer: second }, phase: 'DATABASE_DROP', error: drop });
  await h.prepare(); h.pools[0].emit('error', asynchronous); h.operations.length = 0;
  await assert.rejects(h.cleanup(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, second, drop, asynchronous]);
    assert.equal(error.errors[0].cause, cause); assert.equal(error.errors[0].stack, first.stack);
    const records = Array.from(error.cleanupDiagnostics);
    assert.deepEqual(records.map(r => r.phase), ['POOL_CLOSE', 'POOL_CLOSE', 'DATABASE_DROP', 'ASYNC_POOL_ERROR']);
    assert.deepEqual(records.map(r => r.postgresCode), ['53300', '40001', '42501', '57P01']);
    assert.deepEqual(records.map(r => r.errorName), ['Error', 'TypeError', 'Error', 'Error']);
    for (const r of records) {
      assert.match(r.fixtureId, /^[a-f0-9]{32}$/); assert.equal(r.fixtureId, records[0].fixtureId);
      assert.equal(new Date(r.timestamp).toISOString(), r.timestamp); assert.ok(r.resourceClass); assert.ok(r.message);
    }
    const visible = error.message + JSON.stringify(records);
    for (const secret of [...secrets, sensitive, 'postgresql://', 'Authorization:', 'Cookie:']) assert.equal(visible.includes(secret), false);
    assert.match(error.message, /POOL_CLOSE/); assert.match(error.message, /57P01/);
    return true;
  });
  assert.deepEqual(h.operations, ['END_catalog_admin', 'END_migrator', 'END_issuer', 'END_executor', 'DROP_DATABASE', 'END_admin']);
});

test('H3: real cleanup phase attribution retains abort boundaries and admin-close failures', async () => {
  for (const phase of ['ROLE_DROP', 'DATABASE_ABSENCE_CHECK', 'ROLE_ABSENCE_CHECK', 'AUTO_CONF_HASH_CHECK', 'ADMIN_POOL_CLOSE']) {
    const original = Object.assign(new Error('synthetic-secret-never-in-diagnostic'), { code: '55006' });
    const h = cleanupHarness(cleanupHelper, { phase, error: original,
      endErrors: phase === 'ADMIN_POOL_CLOSE' ? { admin: original } : undefined });
    await h.prepare();
    await assert.rejects(h.cleanup(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 1);
      assert.equal(error.cleanupDiagnostics[0].phase, phase);
      if (phase === 'ROLE_DROP' || phase === 'ADMIN_POOL_CLOSE') assert.equal(error.errors[0], original);
      else assert.equal(error.cleanupDiagnostics[0].errorName, 'AssertionError');
      assert.equal(error.message.includes('synthetic-secret-never-in-diagnostic'), false); return true;
    });
    assert.equal(h.operations.filter(x => x === 'END_admin').length, 1);
  }
});

test('H3: successful cleanup returns without diagnostic output or additional operations', async () => {
  const h = cleanupHarness(cleanupHelper); await h.prepare(); h.operations.length = 0;
  assert.equal(await h.cleanup(), undefined);
  assert.deepEqual(h.operations, ['END_catalog_admin', 'END_migrator', 'END_issuer', 'END_executor',
    'DROP_DATABASE', 'DROP_ROLE', 'DROP_ROLE', 'DROP_ROLE', 'QUERY', 'QUERY', 'END_admin']);
});

test('H3: Node20 TAP exposes artificial cleanup failure, identity, code and time without secrets', () => {
  const script = `const {test}=require('node:test');const harness=(${cleanupHarness.toString()});
    test('synthetic H3 cleanup failure',async t=>{const original=Object.assign(new Error('synthetic-hidden-password-123'),{code:'57P01'});
      const h=harness(${JSON.stringify(cleanupHelper)},{endErrors:{catalog_admin:original}});await h.prepare();t.after(()=>h.cleanup());});`;
  // A child of node --test otherwise inherits the runner's binary IPC reporter.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  for (const field of ['POOL_CLOSE', 'catalog_admin', 'errorName', '57P01', 'timestamp', 'fixtureId']) assert.ok(output.includes(field), field);
  assert.match(output, /[a-f0-9]{32}/); assert.match(output, /\d{4}-\d{2}-\d{2}T/);
  assert.match(output, /not ok/); assert.equal(output.includes('synthetic-hidden-password-123'), false);
});

test('H5: PID ownership and an explicitly targeted cross-fixture termination correlate without PostgreSQL', () => {
  const { connectionTrace } = require('./helpers/sql031PermissionFixture');
  const { EventEmitter } = require('node:events'); const bus = [], idA = 'a'.repeat(32), idB = 'b'.repeat(32);
  const a = connectionTrace(idA, 'unit-cluster', bus), b = connectionTrace(idB, 'unit-cluster', bus);
  const client = new EventEmitter(); client.processID = 12345; a.connected(client, 'migrator');
  const operationId = 'c'.repeat(32), targetDatabase = 'test_sql031_' + idA;
  b.record('DATABASE_DROP_BEGIN', { operationId, targetDatabase, targetPids: [12345], resourceClass: 'database', backendPid: 22222 });
  a.record('CLIENT_ERROR', { backendPid: 12345, resourceClass: 'migrator', error: Object.assign(new Error('synthetic-secret'), { code: '57P01' }) });
  b.record('DATABASE_DROP_END', { operationId, targetDatabase, targetPids: [12345], resourceClass: 'database', backendPid: 22222 });
  const snapshot = a.snapshot();
  assert.equal(snapshot.owners[0].fixtureId, idA); assert.equal(snapshot.owners[0].backendPid, 12345);
  assert.equal(snapshot.correlations[0].origin, 'MATCHED'); assert.equal(snapshot.correlations[0].fixtureId, idB);
  assert.equal(snapshot.correlations[0].backendPid, 12345); assert.equal(snapshot.correlations[0].targetDatabase, targetDatabase);
  client.emit('end'); assert.equal(a.snapshot().owners[0].ended, true);
});

test('H5: unknown, incomplete or ambiguous termination origins stay UNKNOWN; traces are bounded and redacted', () => {
  const { connectionTrace } = require('./helpers/sql031PermissionFixture'); const { EventEmitter } = require('node:events');
  const bus = [], a = connectionTrace('a'.repeat(32), 'unit-cluster', bus), b = connectionTrace('b'.repeat(32), 'unit-cluster', bus);
  const client = new EventEmitter(); client.processID = 12345; a.connected(client, 'migrator');
  const secret = 'postgresql://user:synthetic-password@host/test Authorization: synthetic-token Cookie: synthetic-key';
  a.record('CLIENT_ERROR', { backendPid: 12345, resourceClass: 'migrator', error: Object.assign(new Error(secret), { name: secret, code: '57P01' }) });
  assert.equal(a.snapshot().correlations[0].origin, 'UNKNOWN');
  b.record('DATABASE_DROP_BEGIN', { operationId: 'c'.repeat(32), targetDatabase: 'test_sql031_' + 'a'.repeat(32), targetPids: [12345] });
  assert.equal(a.snapshot().correlations[0].origin, 'UNKNOWN'); // Begin was after the error, and no completion exists.
  const competing = [], receiver = connectionTrace('1'.repeat(32), 'unit-cluster', competing);
  const actors = [connectionTrace('2'.repeat(32), 'unit-cluster', competing), connectionTrace('3'.repeat(32), 'unit-cluster', competing)];
  const other = new EventEmitter(); other.processID = 65432; receiver.connected(other, 'migrator');
  for (let i = 0; i < 2; i++) actors[i].record('DATABASE_DROP_BEGIN', { operationId: String(i + 4).repeat(32), targetDatabase: 'test_sql031_' + '1'.repeat(32), targetPids: [65432] });
  receiver.record('CLIENT_ERROR', { backendPid: 65432, resourceClass: 'migrator', error: Object.assign(new Error('synthetic-secret'), { code: '57P01' }) });
  for (let i = 0; i < 2; i++) actors[i].record('DATABASE_DROP_END', { operationId: String(i + 4).repeat(32), targetDatabase: 'test_sql031_' + '1'.repeat(32), targetPids: [65432] });
  assert.equal(receiver.snapshot().correlations[0].origin, 'UNKNOWN');
  for (let i = 0; i < 600; i++) b.record('DATABASE_DROP_BEGIN', { operationId: 'd'.repeat(32), targetDatabase: secret, targetPids: [12345, secret], error: new Error(secret), resourceClass: secret });
  const output = JSON.stringify({ a: a.snapshot(), b: b.snapshot() });
  for (const part of [secret, 'synthetic-password', 'synthetic-token', 'synthetic-key', 'postgresql://', 'Authorization:', 'Cookie:']) assert.equal(output.includes(part), false);
  assert.ok(b.snapshot().events.length <= 128); assert.ok(bus.length <= 256);
  const unknownClient = connectionTrace('e'.repeat(32), 'unit-cluster', []);
  unknownClient.record('CLIENT_ERROR', { backendPid: 12345 }); assert.equal(unknownClient.snapshot().correlations[0].origin, 'UNKNOWN');
});
