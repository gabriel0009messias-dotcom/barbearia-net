const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');
const { createControlSqlRunner } = require('../services/supervision/sql031Transactions');
const { createSql031Authority } = require('../services/supervision/sql031Authority');

test('SQL031 dormant authority with distinct real PostgreSQL logins and no business mutation', { timeout: 120000 }, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Dedicated local test server required');
  const asyncErrors = [];
  function trackedPool(options) {
    const pool = new Pool(options), clientEnds = [];
    // Track actual end events even after pg-pool removes a discarded Client.
    pool.on('connect', client => {
      clientEnds.push(new Promise(resolve => client.once('end', resolve)));
    });
    pool.on('error', error => { asyncErrors.push(error); });
    return { pool, async close() {
      // end() closes admission; its bookkeeping may finish before Client end.
      try { await pool.end(); } finally { await Promise.all(clientEnds); }
    } };
  }
  const adminOwner = trackedPool({ connectionString: url.toString() }), admin = adminOwner.pool, suffix = randomUUID().replaceAll('-', '');
  const database = 'test_sql031_' + suffix, schema = 'test_' + suffix, s = '"' + schema + '"';
  const roles = { migrator: 'test_migrator_' + suffix, executor: 'test_executor_' + suffix, issuer: 'test_issuer_' + suffix };
  const pools = [], createdRoles = []; let createdDatabase = false;
  t.after(async () => {
    // Start all closures before waiting, retaining errors from every owner.
    const ended = await Promise.allSettled(pools.map(owner => owner.close()));
    const failures = [...asyncErrors, ...ended.filter(r => r.status === 'rejected').map(r => r.reason)];
    try {
      if (!failures.length) {
        if (createdDatabase) await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
        for (const role of createdRoles.reverse()) await admin.query('DROP ROLE "' + role + '"');
      }
    } catch (error) { failures.push(error); }
    finally {
      try { await adminOwner.close(); } catch (error) { failures.push(error); }
    }
    failures.push(...asyncErrors);
    if (failures.length) throw new AggregateError([...new Set(failures)], 'Fixture teardown or asynchronous Pool error');
  });
  const passwords = {};
  for (const [kind, role] of Object.entries(roles)) {
    passwords[kind] = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'' + passwords[kind] + '\'');
    createdRoles.push(role);
  }
  await admin.query('CREATE DATABASE "' + database + '" OWNER "' + roles.migrator + '"'); createdDatabase = true;
  function poolFor(kind) {
    const owner = trackedPool({ host: url.hostname, port: Number(url.port || 5432), database, user: roles[kind], password: passwords[kind], max: 3,
      options: '-c search_path=' + schema + ',public', query_timeout: 0 }); pools.push(owner); return owner.pool;
  }
  const migrator = poolFor('migrator'), executor = poolFor('executor'), issuer = poolFor('issuer');
  await migrate(migrator, schema);
  await migrator.query(`GRANT USAGE ON SCHEMA ${s} TO "${roles.issuer}","${roles.executor}"`);
  const ledger = ['evolution_supervisors', 'evolution_executor_birth_bindings', 'evolution_executor_gates',
    'evolution_executor_closure_events', 'evolution_execution_stop_proofs', 'evolution_execution_stops'];
  await migrator.query(`GRANT SELECT ON ${['evolution_executors', 'evolution_operation_executions', 'evolution_execution_authorizations', ...ledger,
    'evolution_execution_lifecycle_status'].map(x => s + '.' + x).join(',')} TO "${roles.issuer}"`);
  for (const api of ['studiofy_register_supervisor', 'studiofy_register_executor_birth', 'studiofy_accept_executor_closure', 'studiofy_accept_execution_stop']) {
    await migrator.query(`GRANT EXECUTE ON FUNCTION ${s}.${api}(jsonb) TO "${roles.issuer}"`);
  }
  await migrator.query(`GRANT EXECUTE ON FUNCTION ${s}.studiofy_advance_executor_gate(uuid,uuid,uuid,text) TO "${roles.issuer}"`);
  function compose(pool = issuer, login = roles.issuer, extra = {}) {
    const runner = createControlSqlRunner({ pool, authority: 'SUPERVISOR_PROOF_ISSUER', issuerLogin: login,
      migratorLogin: login === roles.migrator ? decodeURIComponent(url.username) : roles.migrator,
      executorLogin: roles.executor, schema, database, localTestOnly: true });
    const identity = extra.identity || { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID() };
    return { runner, identity, authority: createSql031Authority({ transactionRunner: runner, issuerIdentity: identity }) };
  }
  const f = compose(), supervisor = { supervisor_id: f.identity.supervisor_id, supervisor_boot_id: f.identity.supervisor_boot_id,
    protocol_version: 1, process_id: 701, origin: 'local-parent-v1', revision: 'synthetic' };
  const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
    supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 702,
    session_challenge: randomBytes(32).toString('hex'), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
    observed_at: '2026-10-22T00:00:00.000Z', started_at: '2026-10-22T00:00:00.000Z' };
  const ex = { executor_id: birth.executor_id, boot_id: birth.boot_id };
  const closure = { closure_event_id: randomUUID(), proof_type: 'COOPERATIVE_SCOPE_CLOSED', protocol_version: 1,
    executor_id: birth.executor_id, boot_id: birth.boot_id, supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id,
    origin: 'supervisor-ipc-v1', evidence_canonicalization_version: 'pg-jsonb-v1', observed_at: '2026-10-22T01:00:00.000Z', idempotency_key: randomUUID(),
    evidence: { seal_id: randomUUID(), admission_closed: true, scope_closed: true, active_tasks: 0, active_descendants: 0,
      active_transports: 0, pending_callbacks: 0, pending_correlations: 0, pending_sql: 0, unresolved_sql: 0, runtime_profile: birth.runtime_profile } };
  const q = (sql, values) => migrator.query(sql, values);
  let receipt, subject, execution, delivery, token, claim;
  const snapshot = async () => ({ deliveries: (await q(`SELECT * FROM ${s}.whatsapp_messages ORDER BY id`)).rows,
    owners: (await q(`SELECT * FROM ${s}.evolution_instance_owners ORDER BY instance_key`)).rows,
    executions: (await q(`SELECT * FROM ${s}.evolution_operation_executions ORDER BY execution_id`)).rows });

  await t.test('session_user is a distinct authenticated login, not SET ROLE', async () => {
    for (const [kind, pool] of [['migrator', migrator], ['executor', executor], ['issuer', issuer]]) {
      const row = (await pool.query('SELECT session_user,current_user')).rows[0];
      assert.equal(row.session_user, roles[kind]); assert.equal(row.current_user, roles[kind]);
    }
    assert.equal(new Set(Object.values(roles)).size, 3);
  });
  await t.test('executor cannot execute any issuer API or mutate any ledger', async () => {
    for (const api of ['studiofy_register_supervisor', 'studiofy_register_executor_birth', 'studiofy_accept_executor_closure', 'studiofy_accept_execution_stop']) {
      await assert.rejects(executor.query(`SELECT ${s}.${api}('{}'::jsonb)`), { code: '42501' });
    }
    await assert.rejects(executor.query(`SELECT ${s}.studiofy_advance_executor_gate($1,$2,$3,'OPEN')`, [ex.executor_id, ex.boot_id, supervisor.supervisor_id]), { code: '42501' });
    for (const name of ledger) {
      await assert.rejects(executor.query(`DELETE FROM ${s}.${name}`), { code: '42501' });
      await assert.rejects(executor.query(`INSERT INTO ${s}.${name} DEFAULT VALUES`), { code: '42501' });
    }
  });
  await t.test('owner/migrator cannot be used by the runtime adapter even with a misleading authority label', async () => {
    const denied = compose(migrator, roles.migrator);
    assert.equal((await denied.authority.registerSupervisor({ ...supervisor, ...denied.identity })).outcome, 'KNOWN_FAILURE');
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_supervisors`)).rows[0].n, 0);
  });
  await t.test('issuer with accidental direct ledger write privilege is refused before acceptance', async () => {
    await q(`GRANT INSERT ON ${s}.evolution_supervisors TO "${roles.issuer}"`);
    try {
      assert.equal((await f.authority.registerSupervisor(supervisor)).outcome, 'KNOWN_FAILURE');
      assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_supervisors`)).rows[0].n, 0);
    } finally { await q(`REVOKE INSERT ON ${s}.evolution_supervisors FROM "${roles.issuer}"`); }
  });
  await t.test('issuer cannot write ledgers or business directly, but enrolls a fresh birth atomically', async () => {
    for (const name of [...ledger, 'whatsapp_messages', 'evolution_instance_owners']) await assert.rejects(issuer.query(`DELETE FROM ${s}.${name}`), { code: '42501' });
    assert.equal((await f.authority.registerSupervisor(supervisor)).outcome, 'CONFIRMED');
    assert.equal((await f.authority.registerExecutorBirth(birth)).value.state, 'BOOTSTRAPPING');
    assert.equal((await f.authority.registerExecutorBirth(birth)).outcome, 'CONFIRMED');
    const row = (await q(`SELECT b.*,g.state,s.issuer_role FROM ${s}.evolution_executor_birth_bindings b JOIN ${s}.evolution_executor_gates g USING(executor_id,boot_id) JOIN ${s}.evolution_supervisors s USING(supervisor_id)`)).rows[0];
    assert.equal(row.state, 'BOOTSTRAPPING'); assert.equal(row.issuer_role, roles.issuer); assert.match(row.nonce_fingerprint, /^sha256:/);
  });
  await t.test('legacy executor cannot receive retroactive birth or be adopted by delivery selector', async () => {
    const legacy = { executor_id: randomUUID(), boot_id: randomUUID() };
    await q(`INSERT INTO ${s}.evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,703,clock_timestamp())`, [legacy.executor_id, legacy.boot_id]);
    assert.equal((await f.authority.registerExecutorBirth({ ...birth, ...legacy, spawn_id: randomUUID() })).outcome, 'KNOWN_FAILURE');
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_executor_birth_bindings WHERE executor_id=$1`, [legacy.executor_id])).rows[0].n, 0);
    await assert.rejects(f.authority.listExecutionSubjects({ ...legacy, limit: 1, delivery_id: '1' }), { code: 'SQL031_INPUT_INVALID' });
    assert.equal((await f.authority.listExecutionSubjects({ ...legacy, limit: 1 })).outcome, 'KNOWN_FAILURE');
  });
  await t.test('BOOTSTRAPPING denies closure, OPEN allows business fixture setup; unrelated pending delivery is preserved', async () => {
    assert.equal((await f.authority.acceptCooperativeClosure(closure)).outcome, 'KNOWN_FAILURE');
    assert.equal((await f.authority.openExecutorGate(ex)).outcome, 'CONFIRMED');
    await q(`INSERT INTO ${s}.assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
      VALUES(970001,'Synthetic','Synthetic','11999990000','mercado_pago',5,'','sql031-synthetic')`);
    token = '00000000-0000-4000-8000-000000000001'; claim = randomUUID(); execution = randomUUID();
    await q(`UPDATE ${s}.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id='970001'`, [token]);
    delivery = (await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,claimed_at)
      VALUES(970001,'sql031-synthetic','5511999990000',$1,'Synthetic','sending',$2,$3,clock_timestamp()) RETURNING id`, [randomUUID(), claim, token])).rows[0].id;
    await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status)
      VALUES(970001,'sql031-synthetic','5511999990000',$1,'Unrelated','pending')`, [randomUUID()]);
    await q(`INSERT INTO ${s}.evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token)
      VALUES($1,$2,$3,970001,'sql031-synthetic','whatsapp_messages',$4,$5)`, [execution, ex.executor_id, token, delivery, claim]);
    assert.equal((await f.authority.listExecutionSubjects({ ...ex, limit: 10 })).outcome, 'KNOWN_FAILURE');
  });
  await t.test('DRAINING then closure closes gate atomically, without STOPPED or business mutation', async () => {
    const before = await snapshot();
    assert.equal((await f.authority.beginExecutorDraining(ex)).outcome, 'CONFIRMED');
    const r = await f.authority.acceptCooperativeClosure(closure); assert.equal(r.outcome, 'CONFIRMED'); receipt = r.value;
    assert.equal((await q(`SELECT state FROM ${s}.evolution_executor_gates WHERE executor_id=$1`, [ex.executor_id])).rows[0].state, 'CLOSED');
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_execution_stops`)).rows[0].n, 0);
    assert.deepEqual(await snapshot(), before);
    const stored = (await issuer.query(`SELECT evidence_hash FROM ${s}.evolution_executor_closure_events WHERE closure_event_id=$1`, [receipt.closure_event_id])).rows[0];
    assert.equal(receipt.evidence_hash, stored.evidence_hash);
  });
  await t.test('subjects derive from modern CLOSED birth and original SQL token; deterministic fingerprint vector', async () => {
    const r = await f.authority.listExecutionSubjects({ ...ex, limit: 10 }); assert.equal(r.outcome, 'CONFIRMED'); assert.equal(r.value.length, 1);
    subject = r.value[0]; assert.equal(subject.execution_id, execution); assert.equal(subject.assinatura_id, '970001');
    assert.equal(subject.delivery_id, String(delivery)); assert.equal(subject.claim_token, claim);
    assert.equal(subject.operation_token_fingerprint, 'sha256:f977c0f3a57403047d2f17f48be5a6981b1ab7687000070657311f9f9522f50a');
    assert.equal(Object.hasOwn(subject, 'operation_token'), false); assert.doesNotMatch(JSON.stringify(subject), new RegExp(token));
    assert.equal((await f.authority.listExecutionSubjects({ ...ex, limit: 10, after_execution_id: execution })).value.length, 0);
  });
  await t.test('fixed proof wrapper rejects child overrides and persists only proof/projection/authorization', async () => {
    const before = await snapshot(), args = { subject, closureReceipt: receipt, proof_id: randomUUID(), idempotency_key: randomUUID() };
    assert.throws(() => f.authority.acceptExecutionStop({ ...args, subject: { ...subject, assinatura_id: '1' } }), { code: 'SQL031_INPUT_INVALID' });
    assert.throws(() => f.authority.acceptExecutionStop({ ...args, executor_id: randomUUID() }), { code: 'SQL031_INPUT_INVALID' });
    assert.equal((await f.authority.acceptExecutionStop(args)).outcome, 'CONFIRMED');
    assert.equal((await f.authority.acceptExecutionStop(args)).outcome, 'CONFIRMED');
    const row = (await issuer.query(`SELECT * FROM ${s}.evolution_execution_lifecycle_status WHERE execution_id=$1`, [execution])).rows[0];
    assert.equal(row.lifecycle_state, 'STOPPED'); assert.equal(row.proof_id, args.proof_id);
    assert.equal((await f.authority.acceptExecutionStop({ ...args, proof_id: randomUUID() })).outcome, 'KNOWN_FAILURE');
    assert.deepEqual(await snapshot(), before);
  });
  await t.test('same closure request replays idempotently; altered content conflicts; gate never reopens', async () => {
    assert.equal((await f.authority.acceptCooperativeClosure(closure)).outcome, 'CONFIRMED');
    assert.equal((await f.authority.acceptCooperativeClosure({ ...closure, observed_at: '2026-10-22T02:00:00.000Z' })).outcome, 'KNOWN_FAILURE');
    assert.equal((await f.authority.openExecutorGate(ex)).outcome, 'KNOWN_FAILURE');
    assert.equal((await f.authority.beginExecutorDraining(ex)).outcome, 'KNOWN_FAILURE');
  });
  await t.test('lost acknowledgement after real COMMIT is UNKNOWN, no retry, while committed receipt remains visible', async () => {
    let commits = 0, calls = 0;
    const source = { async connect() {
      calls++; const raw = await issuer.connect();
      return { connectionParameters: raw.connectionParameters, release: broken => raw.release(broken), async query(sql, values) {
        const r = await raw.query(sql, values);
        if (sql === 'COMMIT') { commits++; throw Object.assign(Error('Synthetic lost acknowledgement'), { code: '08006' }); }
        return r;
      } };
    } };
    const lost = compose(source), payload = { ...supervisor, ...lost.identity };
    assert.equal((await lost.authority.registerSupervisor(payload)).outcome, 'UNKNOWN');
    assert.equal((await lost.authority.registerSupervisor(payload)).outcome, 'UNKNOWN');
    assert.equal(commits, 1); assert.equal(calls, 1); assert.equal(lost.runner.snapshot().blocked, true);
    assert.equal((await issuer.query(`SELECT supervisor_id FROM ${s}.evolution_supervisors WHERE supervisor_id=$1`, [lost.identity.supervisor_id])).rowCount, 1);
  });
});
