const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { permissionFixture } = require('./helpers/sql031PermissionFixture');
const { validatePermissions, issuerFunctions, ledgers } = require('../services/supervision/sql031Permissions');
test('B2: real separate logins, effective ACLs, operational SQL and issuer-only control', { timeout: 120000 }, async t => {
  const f = await permissionFixture(t), q = (sql, values) => f.migrator.query(sql, values);
  for (const kind of ['migrator', 'issuer', 'executor']) await t.test(kind + ' authenticated profile', async () => {
    assert.equal((await f.validate(kind)).login, f.roles[kind]);
    const wrong = new URL(f.urls[kind]); wrong.password = randomUUID();
    const denied = new Pool({ connectionString: wrong.toString() });
    try { await assert.rejects(denied.query('SELECT 1'), { code: '28P01' }); }
    finally { await denied.end(); }
  });
  await t.test('H1: normal PUBLIC builtins are accepted; redundant EXECUTE adds no capacity', async () => {
    const initial = (await f.executor.query("SELECT has_function_privilege(session_user,'pg_catalog.abs(integer)','EXECUTE') AS executable")).rows[0];
    assert.equal(initial.executable, true);
    await f.validate('executor'); await f.validate('issuer');
    await f.catalogAdmin.query('GRANT EXECUTE ON FUNCTION pg_catalog.abs(integer) TO "' + f.roles.executor + '"');
    try { await f.validate('executor'); }
    finally { await f.catalogAdmin.query('REVOKE EXECUTE ON FUNCTION pg_catalog.abs(integer) FROM "' + f.roles.executor + '"'); }
  });
  // ACL changes only: never invoke the restricted function or read protected data.
  for (const [label, grant, revoke] of [
    ['system function explicit grant', 'GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ', 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM '],
    ['system function grant option', 'GRANT EXECUTE ON FUNCTION pg_catalog.abs(integer) TO ', 'REVOKE EXECUTE ON FUNCTION pg_catalog.abs(integer) FROM '],
    ['system relation explicit grant', 'GRANT SELECT ON pg_catalog.pg_authid TO ', 'REVOKE SELECT ON pg_catalog.pg_authid FROM '],
    ['system column explicit grant', 'GRANT SELECT(rolname) ON pg_catalog.pg_authid TO ', 'REVOKE SELECT(rolname) ON pg_catalog.pg_authid FROM '],
    ['system schema CREATE', 'GRANT CREATE ON SCHEMA pg_catalog TO ', 'REVOKE CREATE ON SCHEMA pg_catalog FROM '],
    ['system type grant option', 'GRANT USAGE ON TYPE pg_catalog.int4 TO ', 'REVOKE USAGE ON TYPE pg_catalog.int4 FROM '],
    ['PUBLIC restricted system function', 'GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ', 'REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM '],
  ]) await t.test('H1: detects ' + label + ' and returns to valid profile after revoke', async () => {
    await f.validate('executor');
    const target = label.startsWith('PUBLIC') ? 'PUBLIC' : '"' + f.roles.executor + '"';
    const option = label.includes('grant option') ? ' WITH GRANT OPTION' : '';
    await f.catalogAdmin.query(grant + target + option);
    try { await assert.rejects(f.validate('executor'), { code: 'SQL031_INPUT_INVALID' }); }
    finally { await f.catalogAdmin.query(revoke + target); }
    await f.validate('executor');
  });
  const executor = '"' + f.roles.executor + '"', issuer = '"' + f.roles.issuer + '"';
  const rejected = () => assert.rejects(f.validate('executor'), { code: 'SQL031_INPUT_INVALID' });
  async function withGrant(grant, revoke, check) {
    await f.validate('executor'); await f.catalogAdmin.query(grant);
    try { if (check) await check(); await rejected(); }
    finally { await f.catalogAdmin.query(revoke); }
    await f.validate('executor');
  }
  await t.test('H2B: CONNECT and trusted language PUBLIC usage accepted; TEMP is unnecessary and disabled', async () => {
    const r = (await f.executor.query("SELECT has_database_privilege(session_user,current_database(),'CONNECT') AS connect,has_database_privilege(session_user,current_database(),'TEMP') AS temp,has_language_privilege(session_user,'plpgsql','USAGE') AS language")).rows[0];
    assert.deepEqual(r, { connect: true, temp: false, language: true }); await f.validate('executor');
  });
  for (const privilege of ['SET', 'ALTER SYSTEM', 'SET WITH GRANT OPTION', 'ALTER SYSTEM WITH GRANT OPTION'])
    await t.test('H2B: parameter ' + privilege + ' rejected without executing it', async () => {
      const base = privilege.replace(' WITH GRANT OPTION', ''), option = privilege.includes('WITH') ? ' WITH GRANT OPTION' : '';
      await withGrant('GRANT ' + base + ' ON PARAMETER log_statement TO ' + executor + option,
        'REVOKE ' + base + ' ON PARAMETER log_statement FROM ' + executor, async () => {
          assert.equal((await f.executor.query('SELECT has_parameter_privilege(session_user,$1,$2) AS permitted', ['log_statement', privilege])).rows[0].permitted, true);
        });
    });
  await t.test('H2B: ordinary user-settable parameter SET is not excessive; delegation still rejected', async () => {
    assert.equal((await f.executor.query("SELECT context FROM pg_settings WHERE name='work_mem'")).rows[0].context, 'user');
    await f.catalogAdmin.query('GRANT SET ON PARAMETER work_mem TO ' + executor);
    try { await f.validate('executor'); } finally { await f.catalogAdmin.query('REVOKE SET ON PARAMETER work_mem FROM ' + executor); }
    await withGrant('GRANT SET ON PARAMETER work_mem TO ' + executor + ' WITH GRANT OPTION', 'REVOKE SET ON PARAMETER work_mem FROM ' + executor);
  });
  await t.test('H2B: effective parameter privilege inherited through a role is rejected', async () => {
    await f.catalogAdmin.query('GRANT SET ON PARAMETER log_statement TO ' + issuer);
    try {
      await f.admin.query('GRANT ' + issuer + ' TO ' + executor + ' WITH INHERIT TRUE');
      try {
        assert.equal((await f.executor.query("SELECT has_parameter_privilege(session_user,'log_statement','SET') AS permitted")).rows[0].permitted, true);
        await rejected();
      } finally { await f.admin.query('REVOKE ' + issuer + ' FROM ' + executor); }
    } finally { await f.catalogAdmin.query('REVOKE SET ON PARAMETER log_statement FROM ' + issuer); }
    await f.validate('executor');
  });
  await t.test('H2B: PUBLIC parameter grant rejected only in the identity-verified private cluster', async () => {
    await withGrant('GRANT ALTER SYSTEM ON PARAMETER log_statement TO PUBLIC', 'REVOKE ALTER SYSTEM ON PARAMETER log_statement FROM PUBLIC');
  });
  for (const privilege of ['CREATE', 'TEMP', 'CONNECT WITH GRANT OPTION'])
    await t.test('H2B: database ' + privilege + ' rejected', async () => {
      const base = privilege.replace(' WITH GRANT OPTION', ''), option = privilege.includes('WITH') ? ' WITH GRANT OPTION' : '';
      await withGrant('GRANT ' + base + ' ON DATABASE "' + f.database + '" TO ' + executor + option,
        'REVOKE ' + base + ' ON DATABASE "' + f.database + '" FROM ' + executor);
    });
  await t.test('H2B: database owner cannot be the executor', async () => {
    await assert.rejects(f.validate('migrator', { profile: 'EXECUTOR' }), { code: 'SQL031_INPUT_INVALID' });
  });
  for (const option of ['', ' WITH GRANT OPTION']) await t.test('H2B: tablespace CREATE' + option + ' rejected without creating storage', async () => {
    await withGrant('GRANT CREATE ON TABLESPACE pg_default TO ' + executor + option, 'REVOKE CREATE ON TABLESPACE pg_default FROM ' + executor,
      async () => assert.equal((await f.executor.query("SELECT has_tablespace_privilege(session_user,'pg_default','CREATE') AS permitted")).rows[0].permitted, true));
  });
  await t.test('H2B: language grant option rejected while normal PUBLIC usage remains', async () => {
    await withGrant('GRANT USAGE ON LANGUAGE plpgsql TO ' + executor + ' WITH GRANT OPTION', 'REVOKE USAGE ON LANGUAGE plpgsql FROM ' + executor);
  });
  await t.test('H2B: handler-free dummy FDW grants and ownership rejected, no foreign server or connection', async () => {
    const name = 'test_fdw_' + randomUUID().replaceAll('-', ''), object = '"' + name + '"';
    await f.catalogAdmin.query('CREATE FOREIGN DATA WRAPPER ' + object + ' NO HANDLER NO VALIDATOR');
    try {
      for (const option of ['', ' WITH GRANT OPTION']) await withGrant('GRANT USAGE ON FOREIGN DATA WRAPPER ' + object + ' TO ' + executor + option,
        'REVOKE USAGE ON FOREIGN DATA WRAPPER ' + object + ' FROM ' + executor);
      // PostgreSQL itself requires a superuser FDW owner. Never elevate executor.
      await assert.rejects(f.catalogAdmin.query('ALTER FOREIGN DATA WRAPPER ' + object + ' OWNER TO ' + executor), { code: '42501' });
    } finally { await f.catalogAdmin.query('DROP FOREIGN DATA WRAPPER ' + object); }
    await f.validate('executor');
  });
  await t.test('H2B: reducing own future defaults does not confer ownership authority', async () => {
    await f.executor.query('ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    try { await f.validate('executor'); }
    finally { await f.executor.query('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC'); }
    await f.validate('executor');
  });
  await t.test('H2B: large-object allocation capability rejected even when introduced via PUBLIC', async () => {
    await withGrant('GRANT EXECUTE ON FUNCTION pg_catalog.lo_create(oid) TO PUBLIC', 'REVOKE EXECUTE ON FUNCTION pg_catalog.lo_create(oid) FROM PUBLIC');
  });
  await t.test('H2B: empty large-object ACL and ownership rejected without payload access', async () => {
    const oid = (await f.catalogAdmin.query('SELECT lo_create(0) AS oid')).rows[0].oid;
    const admin = (await f.catalogAdmin.query('SELECT session_user::text AS name')).rows[0].name;
    try {
      for (const privilege of ['SELECT', 'UPDATE', 'SELECT WITH GRANT OPTION']) {
        const base = privilege.replace(' WITH GRANT OPTION', ''), option = privilege.includes('WITH') ? ' WITH GRANT OPTION' : '';
        await withGrant('GRANT ' + base + ' ON LARGE OBJECT ' + oid + ' TO ' + executor + option,
          'REVOKE ' + base + ' ON LARGE OBJECT ' + oid + ' FROM ' + executor);
      }
      await f.catalogAdmin.query('ALTER LARGE OBJECT ' + oid + ' OWNER TO ' + executor);
      try { await rejected(); } finally { await f.catalogAdmin.query('ALTER LARGE OBJECT ' + oid + ' OWNER TO "' + admin + '"'); }
    } finally { await f.catalogAdmin.query('SELECT lo_unlink($1)', [oid]); }
    await f.validate('executor');
  });
  await t.test('executor cannot invoke any issuer API', async () => {
    for (const api of issuerFunctions) {
      const call = api.includes('(jsonb)') ? api.replace('(jsonb)', "('{}'::jsonb)") :
        api.replace('(uuid,uuid,uuid,text)', "(NULL::uuid,NULL::uuid,NULL::uuid,'OPEN')");
      await assert.rejects(f.executor.query('SELECT ' + f.s + '.' + call), { code: '42501' });
    }
  });
  await t.test('executor cannot mutate any control ledger', async () => {
    for (const name of ledgers) for (const sql of ['INSERT INTO ' + name + ' DEFAULT VALUES', 'DELETE FROM ' + name,
      'TRUNCATE ' + name, 'UPDATE ' + name + ' SET executor_id=NULL']) {
      // Use a valid column for UPDATE, so permission denial is the actual cause.
      const statement = name === 'evolution_supervisors' ? sql.replace('executor_id', 'supervisor_id') :
        name === 'evolution_execution_stops' ? sql.replace('executor_id', 'execution_id') : sql;
      await assert.rejects(f.executor.query(statement), { code: '42501' });
    }
  });
  await t.test('executor cannot DDL, own objects, create roles or SET ROLE to control logins', async () => {
    for (const sql of ['CREATE TABLE forbidden(id int)', 'CREATE TEMP TABLE forbidden(id int)',
      'CREATE SCHEMA forbidden', 'ALTER TABLE whatsapp_messages ADD COLUMN forbidden int',
      'ALTER TABLE whatsapp_messages OWNER TO "' + f.roles.executor + '"',
      'CREATE ROLE forbidden', 'ALTER ROLE "' + f.roles.executor + '" SUPERUSER',
      'GRANT "' + f.roles.issuer + '" TO "' + f.roles.executor + '"',
      'SET ROLE "' + f.roles.issuer + '"', 'SET ROLE "' + f.roles.migrator + '"'])
      await assert.rejects(f.executor.query(sql), { code: '42501' });
    // PostgreSQL can acknowledge GRANT/REVOKE with warnings; prove no authority was conferred.
    await f.executor.query('GRANT SELECT ON whatsapp_messages TO "' + f.roles.issuer + '"');
    await f.executor.query('REVOKE SELECT ON whatsapp_messages FROM "' + f.roles.issuer + '"');
    assert.equal((await f.issuer.query("SELECT has_table_privilege(session_user,'whatsapp_messages','SELECT') AS allowed")).rows[0].allowed, false);
  });
  await t.test('excess direct, inherited, column and grant-option privileges are rejected', async () => {
    const role = '"' + f.roles.executor + '"';
    for (const [grant, revoke] of [
      ['GRANT EXECUTE ON FUNCTION studiofy_accept_executor_closure(jsonb) TO ' + role, 'REVOKE EXECUTE ON FUNCTION studiofy_accept_executor_closure(jsonb) FROM ' + role],
      ['GRANT UPDATE(supervisor_id) ON evolution_supervisors TO ' + role, 'REVOKE UPDATE(supervisor_id) ON evolution_supervisors FROM ' + role],
      ['GRANT SELECT ON whatsapp_messages TO ' + role + ' WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR SELECT ON whatsapp_messages FROM ' + role],
      ['GRANT SELECT(id) ON whatsapp_messages TO ' + role + ' WITH GRANT OPTION', 'REVOKE GRANT OPTION FOR SELECT(id) ON whatsapp_messages FROM ' + role],
    ]) { await q(grant); try { await assert.rejects(f.validate('executor'), { code: 'SQL031_INPUT_INVALID' }); } finally { await q(revoke); } }
    for (const target of [f.roles.issuer, f.roles.migrator]) {
      await f.admin.query('GRANT "' + target + '" TO ' + role);
      try { await assert.rejects(f.validate('executor'), { code: 'SQL031_INPUT_INVALID' }); }
      finally { await f.admin.query('REVOKE "' + target + '" FROM ' + role); }
    }
    assert.equal((await f.validate('executor')).profile, 'EXECUTOR');
  });
  await t.test('SET ROLE identity is rejected even when permission set is the target profile', async () => {
    await f.admin.query('GRANT "' + f.roles.executor + '" TO "' + f.roles.migrator + '"');
    const c = await f.migrator.connect();
    try {
      await c.query('SET ROLE "' + f.roles.executor + '"');
      await assert.rejects(validatePermissions(c, { profile: 'EXECUTOR', expectedLogin: f.roles.executor, schema: f.schema, database: f.database }), { code: 'SQL031_INPUT_INVALID' });
    } finally {
      await c.query('RESET ROLE'); c.release();
      await f.admin.query('REVOKE "' + f.roles.executor + '" FROM "' + f.roles.migrator + '"');
    }
  });
  await t.test('issuer cannot write business or ledgers directly; control function works without Evolution', async () => {
    await assert.rejects(f.issuer.query('INSERT INTO whatsapp_messages DEFAULT VALUES'), { code: '42501' });
    await assert.rejects(f.issuer.query('INSERT INTO evolution_supervisors DEFAULT VALUES'), { code: '42501' });
    const id = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID() };
    const result = await f.authority(id).registerSupervisor({ ...id, protocol_version: 1, process_id: process.pid, origin: 'local-parent-v1' });
    assert.equal(result.outcome, 'CONFIRMED');
  });
  await t.test('executor can claim, reserve, register, authorize, cross frontier and atomically finalize', async () => {
    const controlId = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID() }, control = f.authority(controlId);
    assert.equal((await control.registerSupervisor({ ...controlId, protocol_version: 1, process_id: process.pid, origin: 'local-parent-v1' })).outcome, 'CONFIRMED');
    const executor_id = randomUUID(), boot_id = randomUUID();
    assert.equal((await control.registerExecutorBirth({ ...controlId, executor_id, boot_id, spawn_id: randomUUID(), observed_pid: process.pid,
      session_challenge: 'a'.repeat(64), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
      observed_at: new Date().toISOString(), started_at: new Date().toISOString() })).outcome, 'CONFIRMED');
    assert.equal((await control.openExecutorGate({ executor_id, boot_id })).outcome, 'CONFIRMED');
    await q("INSERT INTO assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,status,proximo_vencimento,whatsapp_session) VALUES(981001,'Synthetic','Owner','11999990000','mercado_pago',5,'','ativo','2099-01-01','permission-synthetic')");
    const token = randomUUID(), claim = randomUUID(), execution = randomUUID();
    const message = (await f.executor.query("INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,claimed_at) VALUES(981001,'permission-synthetic','5511999990000',$1,'Synthetic','sending',$2,CURRENT_TIMESTAMP) RETURNING id", [randomUUID(), claim])).rows[0];
    const c = await f.executor.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='981001'", [token]);
      await c.query('UPDATE whatsapp_messages SET operation_token=$1 WHERE id=$2', [token, message.id]);
      await c.query("SELECT studiofy_execution_lock_gate($1,'admission')", [executor_id]);
      await c.query("INSERT INTO evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token) VALUES($1,$2,$3,981001,'permission-synthetic','whatsapp_messages',$4,$5)", [execution, executor_id, token, message.id, claim]);
      await c.query('COMMIT');
      await c.query('BEGIN'); await c.query("SELECT studiofy_execution_lock_gate($1,'boundary')", [executor_id]);
      await c.query('UPDATE whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1 AND claim_token=$2', [message.id, claim]);
      await c.query('COMMIT');
      await c.query('BEGIN'); await c.query('SELECT studiofy_execution_lock_finalization($1)', [token]);
      await c.query("UPDATE whatsapp_messages SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=$1", [message.id]);
      await c.query("UPDATE evolution_execution_authorizations SET state='UNKNOWN' WHERE execution_id=$1", [execution]);
      await c.query("UPDATE evolution_instance_owners SET operation_token=NULL,operation_started_at=NULL WHERE owner_id='981001'");
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    assert.equal((await f.executor.query('SELECT status FROM whatsapp_messages WHERE id=$1', [message.id])).rows[0].status, 'sent');
    await f.noStop();
  });
});
