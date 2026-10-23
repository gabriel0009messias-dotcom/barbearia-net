const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../database/migrate');
const { createControlSqlRunner } = require('../services/supervision/sql031Transactions');
const { createDormantSql031Gate } = require('../services/supervision/sql031GateIntegration');
const p = require('../services/supervision/sql031Payloads');
const { createSql031Authority } = require('../services/supervision/sql031Authority');

test('SQL031 2C dormant stop integration with real separated PostgreSQL logins', { timeout: 120000 }, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Dedicated local test server required');
  const admin = new Pool({ connectionString: url.toString() }), suffix = randomUUID().replaceAll('-', '');
  const database = 'test_sql031_' + suffix, schema = 'test_' + suffix, s = '"' + schema + '"';
  const roles = { migrator: 'test_migrator_' + suffix, executor: 'test_executor_' + suffix, issuer: 'test_issuer_' + suffix };
  const pools = [], createdRoles = []; let createdDatabase = false;
  t.after(async () => {
    for (const pool of pools) await pool.end();
    if (createdDatabase) await admin.query('DROP DATABASE "' + database + '" WITH (FORCE)');
    for (const role of createdRoles.reverse()) await admin.query('DROP ROLE "' + role + '"');
    await admin.end();
  });
  const passwords = {};
  for (const [kind, role] of Object.entries(roles)) {
    passwords[kind] = randomBytes(24).toString('hex');
    await admin.query('CREATE ROLE "' + role + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD \'' + passwords[kind] + '\'');
    createdRoles.push(role);
  }
  await admin.query('CREATE DATABASE "' + database + '" OWNER "' + roles.migrator + '"'); createdDatabase = true;
  function poolFor(kind) {
    const pool = new Pool({ host: url.hostname, port: Number(url.port || 5432), database, user: roles[kind], password: passwords[kind], max: 6,
      options: '-c search_path=' + schema + ',public', query_timeout: 0 }); pools.push(pool); return pool;
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
  const q = (sql, values) => migrator.query(sql, values);
  const proofSql = `SELECT ${s}.studiofy_accept_execution_stop($1::jsonb) AS id`;
  const ledgerCount = async name => (await q(`SELECT count(*)::int n FROM ${s}.${name}`)).rows[0].n;
  const lifecycle = async id => (await issuer.query(`SELECT * FROM ${s}.evolution_execution_lifecycle_status WHERE execution_id=$1`, [id])).rows[0];
  const snapshot = async () => {
    const result = {};
    for (const table of ['whatsapp_messages', 'appointment_reminders', 'evolution_instance_owners',
      'evolution_delivery_reconciliations', 'return_reminders', 'whatsapp_conversation_responses', 'evolution_operation_executions']) {
      result[table] = (await q(`SELECT to_jsonb(x) AS row FROM ${s}.${table} x ORDER BY to_jsonb(x)::text`)).rows;
    }
    return result;
  };
  let tenant = 980100;
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const fault = { enabled: false, calls: 0, lost: 0, hold: null, holdAt: null, seen: null, queries: 0 };
  const injected = { async connect() {
    const raw = await issuer.connect(); let proof = false;
    return { connectionParameters: raw.connectionParameters, release: broken => raw.release(broken), async query(sql, values) {
      fault.queries++;
      if (sql.includes('.studiofy_accept_execution_stop(')) {
        proof = true; fault.calls++;
        if (fault.hold && fault.calls === fault.holdAt) { fault.seen.resolve(); await fault.hold.promise; }
      }
      const result = await raw.query(sql, values);
      if (sql === 'COMMIT' && proof && fault.enabled) {
        fault.lost++; fault.enabled = false;
        throw Object.assign(Error('Synthetic ACK loss after actual PostgreSQL COMMIT'), { code: '08006' });
      }
      return result;
    } };
  } };
  async function candidate(count = 2, pool = issuer) {
    const supervisor = { supervisor_id: randomUUID(), supervisor_boot_id: randomUUID(), protocol_version: 1,
      process_id: 801, origin: 'local-parent-v1' };
    const birth = { executor_id: randomUUID(), boot_id: randomUUID(), supervisor_id: supervisor.supervisor_id,
      supervisor_boot_id: supervisor.supervisor_boot_id, spawn_id: randomUUID(), observed_pid: 802,
      session_challenge: randomBytes(32).toString('hex'), protocol_version: 1, runtime_profile: 'evolution-single-process-v1',
      observed_at: '2026-10-23T00:00:00.000Z', started_at: '2026-10-23T00:00:00.000Z' };
    const runner = createControlSqlRunner({ pool, authority: 'SUPERVISOR_PROOF_ISSUER', issuerLogin: roles.issuer,
      migratorLogin: roles.migrator, executorLogin: roles.executor, schema, database, localTestOnly: true });
    const gate = createDormantSql031Gate({ transactionRunner: runner, supervisor, birth, requiredCapabilities: ['listener'] });
    gate.executor.registerCapability('listener', () => {});
    assert.throws(() => gate.createStopProjection());
    assert.equal((await gate.bootstrap()).outcome, 'CONFIRMED'); assert.equal((await gate.open()).outcome, 'CONFIRMED');
    const executions = [];
    for (let i = 0; i < count; i++) {
      const id = ++tenant, instance = 'sql031-stop-' + id, token = randomUUID(), claim = randomUUID(), execution = randomUUID();
      await q(`INSERT INTO ${s}.assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
        VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2)`, [id, instance]);
      await q(`UPDATE ${s}.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2`, [token, String(id)]);
      const delivery = (await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,claimed_at)
        VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,$5,clock_timestamp()) RETURNING id`, [id, instance, randomUUID(), claim, token])).rows[0].id;
      await q(`INSERT INTO ${s}.evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token)
        VALUES($1,$2,$3,$4,$5,'whatsapp_messages',$6,$7)`, [execution, birth.executor_id, token, id, instance, delivery, claim]);
      // Simulate an ambiguous transport result locally, without any actual transport.
      await q(`UPDATE ${s}.whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1`, [delivery]);
      await q(`UPDATE ${s}.whatsapp_messages SET status='uncertain' WHERE id=$1`, [delivery]);
      await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status)
        VALUES($1,$2,'5511999990000',$3,'Unrelated pending outbox entry','pending')`, [id, instance, randomUUID()]);
      executions.push(execution);
    }
    const close = await gate.close(); assert.equal(close.outcome, 'CONFIRMED');
    return { gate, runner, birth, supervisor, executions: executions.sort(), receipt: close.value };
  }
  const payloads = async f => {
    // Read-only independent authority for SQL-negative fixtures, never substituted into the runtime capability.
    const authority = compose(issuer, roles.issuer, { identity: { supervisor_id: f.supervisor.supervisor_id,
      supervisor_boot_id: f.supervisor.supervisor_boot_id } }).authority;
    const selected = await authority.listExecutionSubjects({ executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 100 });
    assert.equal(selected.outcome, 'CONFIRMED');
    return selected.value.map(subject => p.proof({ proof_id: randomUUID(), idempotency_key: randomUUID() }, subject, f.receipt));
  };

  await t.test('real session_user/current_user and grants/revokes keep executor outside proof authority', async () => {
    for (const [kind, pool] of [['migrator', migrator], ['executor', executor], ['issuer', issuer]]) {
      const row = (await pool.query('SELECT session_user,current_user')).rows[0];
      assert.equal(row.session_user, roles[kind]); assert.equal(row.current_user, roles[kind]);
    }
    assert.equal(new Set(Object.values(roles)).size, 3);
    for (const api of ['studiofy_register_supervisor', 'studiofy_register_executor_birth', 'studiofy_accept_executor_closure', 'studiofy_accept_execution_stop']) {
      await assert.rejects(executor.query(`SELECT ${s}.${api}('{}'::jsonb)`), { code: '42501' });
    }
    for (const table of ledger) {
      await assert.rejects(executor.query(`INSERT INTO ${s}.${table} DEFAULT VALUES`), { code: '42501' });
      await assert.rejects(issuer.query(`DELETE FROM ${s}.${table}`), { code: '42501' });
    }
    await q(`REVOKE EXECUTE ON FUNCTION ${s}.studiofy_accept_execution_stop(jsonb) FROM "${roles.issuer}"`);
    try { await assert.rejects(issuer.query(proofSql, ['{}']), { code: '42501' }); }
    finally { await q(`GRANT EXECUTE ON FUNCTION ${s}.studiofy_accept_execution_stop(jsonb) TO "${roles.issuer}"`); }
  });

  const f = await candidate(2, injected), before = await snapshot();
  let cap, successful;
  await t.test('modern birth and CLOSED closure are persisted; CLOSED alone does not project STOPPED', async () => {
    const row = (await issuer.query(`SELECT b.*,g.state FROM ${s}.evolution_executor_birth_bindings b JOIN ${s}.evolution_executor_gates g USING(executor_id,boot_id) WHERE b.executor_id=$1`, [f.birth.executor_id])).rows[0];
    assert.equal(row.boot_id, f.birth.boot_id); assert.equal(row.state, 'CLOSED');
    assert.equal(f.receipt.evidence_canonicalization_version, 'pg-jsonb-v1');
    assert.equal(await ledgerCount('evolution_execution_stops'), 0);
    for (const id of f.executions) assert.equal((await lifecycle(id)).lifecycle_state, 'UNKNOWN');
    for (const k of ['authority', 'createStopProjection', 'subjects', 'acceptExecutionStop', 'closureReceipt']) assert.equal(f.gate.executor[k], undefined);
    cap = f.gate.createStopProjection();
    await assert.rejects(cap.certifyNextPage({ execution_id: f.executions[0] }));
    assert.equal(fault.calls, 0);
  });

  await t.test('SQL rejects mismatched tenant, instance, claim, execution, boot, schema, fingerprint and evidence atomically', async () => {
    const [valid] = await payloads(f);
    const changes = [{ assinatura_id: '1' }, { instance_name: 'foreign-synthetic' }, { claim_token: randomUUID() },
      { execution_id: f.executions[1] }, { boot_id: randomUUID() }, { source_schema: 'test_' + 'f'.repeat(32) },
      { operation_token_fingerprint: 'sha256:' + '0'.repeat(64) }, { evidence_hash: 'sha256:' + '0'.repeat(64) },
      { evidence_canonicalization_version: 'js-hmac-v1' }];
    for (const change of changes) await assert.rejects(issuer.query(proofSql, [JSON.stringify({ ...valid, ...change })]), { code: '23514' });
    assert.equal(await ledgerCount('evolution_execution_stop_proofs'), 0); assert.equal(await ledgerCount('evolution_execution_stops'), 0);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('rollback removes proof/projection/revocation together', async () => {
    const [valid] = await payloads(f), client = await issuer.connect();
    try {
      await client.query('BEGIN'); await client.query(proofSql, [JSON.stringify(valid)]);
      await assert.rejects(client.query('SELECT 1/0'), { code: '22012' }); await client.query('ROLLBACK');
    } finally { client.release(); }
    assert.equal(await ledgerCount('evolution_execution_stop_proofs'), 0); assert.equal(await ledgerCount('evolution_execution_stops'), 0);
    const states = (await issuer.query(`SELECT state FROM ${s}.evolution_execution_authorizations`)).rows;
    assert.equal(states.every(x => x.state === 'ACTIVE'), true); assert.deepEqual(await snapshot(), before);
  });

  await t.test('2C creates individual proof-backed STOPPED: A confirmed while B remains UNKNOWN', async () => {
    const hold = deferred(), seen = deferred();
    // Pause the second individual proof before it reaches PostgreSQL.
    fault.hold = hold; fault.holdAt = fault.calls + 2; fault.seen = seen;
    const pending = cap.certifyNextPage();
    try {
      await Promise.race([seen.promise, pause(5000).then(() => { throw Error('Second individual proof was not reached'); })]);
      assert.equal((await lifecycle(f.executions[0])).lifecycle_state, 'STOPPED');
      assert.equal((await lifecycle(f.executions[1])).lifecycle_state, 'UNKNOWN');
      assert.equal(await ledgerCount('evolution_execution_stop_proofs'), 1);
    } finally { fault.hold = null; fault.holdAt = null; hold.resolve(); }
    successful = await pending; assert.equal(successful.outcome, 'CONFIRMED'); assert.equal(successful.value.confirmed.length, 2);
    assert.equal(await ledgerCount('evolution_execution_stop_proofs'), 2); assert.equal(await ledgerCount('evolution_execution_stops'), 2);
    for (const id of f.executions) assert.equal((await lifecycle(id)).lifecycle_state, 'STOPPED');
    assert.equal((await issuer.query(`SELECT state FROM ${s}.evolution_execution_authorizations WHERE execution_id=ANY($1::uuid[])`, [f.executions])).rows.every(x => x.state === 'UNKNOWN'), true);
    assert.deepEqual(await snapshot(), before);
    const n = fault.queries; assert.strictEqual(await cap.certifyNextPage(), successful); assert.equal(fault.queries, n);
  });

  await t.test('identical SQL replay is idempotent; changed idempotency content fails; runtime still does not replay', async () => {
    const row = (await issuer.query(`SELECT * FROM ${s}.evolution_execution_stop_proofs WHERE execution_id=$1`, [f.executions[0]])).rows[0];
    const [base] = await payloads(f), exact = { ...base, proof_id: row.proof_id, idempotency_key: row.idempotency_key };
    assert.equal((await issuer.query(proofSql, [JSON.stringify(exact)])).rows[0].id, row.proof_id);
    await assert.rejects(issuer.query(proofSql, [JSON.stringify({ ...exact, proof_id: randomUUID() })]), { code: '23514' });
    assert.equal(await ledgerCount('evolution_execution_stop_proofs'), 2);
    const n = fault.calls; assert.strictEqual(await cap.certifyNextPage(), successful); assert.equal(fault.calls, n);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('real advisory gate lock serializes concurrent identical SQL acceptances', async () => {
    const g = await candidate(1), [valid] = await payloads(g), a = await issuer.connect(), b = await issuer.connect();
    let pending;
    try {
      await a.query('BEGIN'); await a.query(proofSql, [JSON.stringify(valid)]);
      const pid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = b.query(proofSql, [JSON.stringify(valid)]);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const row = (await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
        if (row?.wait_event_type === 'Lock') { waiting = true; break; } await pause(10);
      }
      assert.equal(waiting, true, 'second acceptance must wait on an actual PostgreSQL lock');
      await a.query('COMMIT'); assert.equal((await pending).rows[0].id, valid.proof_id); pending = null;
      assert.equal((await lifecycle(g.executions[0])).lifecycle_state, 'STOPPED');
    } finally { await a.query('ROLLBACK'); if (pending) await pending; a.release(); b.release(); }
    assert.equal((await issuer.query(`SELECT count(*)::int n FROM ${s}.evolution_execution_stop_proofs WHERE execution_id=$1`, [g.executions[0]])).rows[0].n, 1);
  });

  await t.test('actual proof COMMIT with lost ACK is UNKNOWN terminal, without retry/repair/reexecution', async () => {
    const g = await candidate(2, injected), stop = g.gate.createStopProjection(), prior = await snapshot();
    fault.enabled = true; const n = fault.calls;
    const result = await stop.certifyNextPage(); assert.equal(result.outcome, 'UNKNOWN');
    assert.equal(result.value.cursor, null); assert.equal(result.value.confirmed.length, 0);
    assert.equal((await lifecycle(g.executions[0])).lifecycle_state, 'STOPPED');
    assert.equal((await lifecycle(g.executions[1])).lifecycle_state, 'UNKNOWN');
    assert.equal(fault.lost, 1); assert.equal(fault.calls, n + 1);
    const queries = fault.queries, attempt = stop.snapshot().attempt;
    for (let i = 0; i < 3; i++) assert.strictEqual(await stop.certifyNextPage(), result);
    assert.strictEqual(g.gate.createStopProjection(), stop); assert.strictEqual(stop.snapshot().attempt, attempt);
    assert.equal(fault.queries, queries); assert.equal(g.runner.snapshot().blocked, true);
    assert.deepEqual(await snapshot(), prior);
  });

  await t.test('legacy executor cannot acquire retroactive birth, closure, subjects or STOPPED', async () => {
    const legacy = { executor_id: randomUUID(), boot_id: randomUUID() }, fixture = compose();
    const supervisor = { ...fixture.identity, protocol_version: 1, process_id: 901, origin: 'local-parent-v1' };
    assert.equal((await fixture.authority.registerSupervisor(supervisor)).outcome, 'CONFIRMED');
    await q(`INSERT INTO ${s}.evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,902,clock_timestamp())`, [legacy.executor_id, legacy.boot_id]);
    const id = ++tenant, instance = 'sql031-legacy-' + id, token = randomUUID();
    await q(`INSERT INTO ${s}.assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
      VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2)`, [id, instance]);
    await q(`UPDATE ${s}.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2`, [token, String(id)]);
    await q(`INSERT INTO ${s}.evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind)
      VALUES($1,$2,$3,$4,$5,'instance_operation')`, [randomUUID(), legacy.executor_id, token, id, instance]);
    assert.equal((await fixture.authority.registerExecutorBirth({ ...f.birth, ...legacy, ...fixture.identity, spawn_id: randomUUID() })).outcome, 'KNOWN_FAILURE');
    assert.equal((await fixture.authority.listExecutionSubjects({ ...legacy, limit: 100 })).outcome, 'KNOWN_FAILURE');
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_executor_birth_bindings WHERE executor_id=$1`, [legacy.executor_id])).rows[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_execution_stops st JOIN ${s}.evolution_operation_executions e USING(execution_id) WHERE e.executor_id=$1`, [legacy.executor_id])).rows[0].n, 0);
  });
});
