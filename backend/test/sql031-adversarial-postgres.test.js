const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { postgresFixture } = require('./helpers/sql031AdversarialFixtures');

test('2D: adversarial PostgreSQL authority, lifecycle and transport isolation', { timeout: 180000 }, async t => {
  const h = await postgresFixture(t);
  const { s, roles, q, issuer, adversary, executor, compose, candidate, payloads, proofSql, lifecycle, snapshot, fault, injected } = h;
  const controlSnapshot = async () => {
    const result = {};
    for (const table of h.ledger) result[table] = (await q(`SELECT to_jsonb(x) r FROM ${s}.${table} x ORDER BY to_jsonb(x)::text`)).rows;
    return result;
  };
  const closurePayload = async f => (await q(`SELECT closure_event_id,proof_type,protocol_version,executor_id,boot_id,
    supervisor_id,supervisor_boot_id,origin,evidence_canonicalization_version,evidence,observed_at,idempotency_key
    FROM ${s}.evolution_executor_closure_events WHERE closure_event_id=$1`, [f.receipt.closure_event_id])).rows[0];

  await t.test('A01/I01/I03: direct logins, executor API/DML/DDL and SET ROLE denial', async () => {
    for (const [kind, pool] of [['migrator', h.migrator], ['executor', executor], ['issuer', issuer], ['adversary', adversary]]) {
      const row = (await pool.query('SELECT session_user,current_user')).rows[0];
      assert.equal(row.session_user, roles[kind]); assert.equal(row.current_user, roles[kind]);
    }
    const before = await controlSnapshot();
    for (const api of ['studiofy_register_supervisor', 'studiofy_register_executor_birth', 'studiofy_accept_executor_closure', 'studiofy_accept_execution_stop']) {
      await assert.rejects(executor.query(`SELECT ${s}.${api}('{}'::jsonb)`), { code: '42501' });
    }
    await assert.rejects(executor.query(`SELECT ${s}.studiofy_advance_executor_gate($1,$2,$3,'OPEN')`, [randomUUID(), randomUUID(), randomUUID()]), { code: '42501' });
    for (const table of h.ledger) {
      await assert.rejects(executor.query(`INSERT INTO ${s}.${table} DEFAULT VALUES`), { code: '42501' });
      await assert.rejects(executor.query(`DELETE FROM ${s}.${table}`), { code: '42501' });
      await assert.rejects(executor.query(`TRUNCATE ${s}.${table}`), { code: '42501' });
    }
    await assert.rejects(executor.query(`CREATE TABLE ${s}.forbidden_fixture(id int)`), { code: '42501' });
    for (const role of [roles.issuer, roles.migrator]) {
      const client = await executor.connect();
      try { await assert.rejects(client.query(`SET ROLE "${role}"`), { code: '42501' }); }
      finally { await client.query('RESET ROLE'); client.release(); }
    }
    assert.deepEqual(await controlSnapshot(), before);
  });

  await t.test('I02/I03: migrator, excess grants and changed current_user cannot become runtime issuer', async () => {
    const before = await controlSnapshot();
    const attempt = f => f.authority.registerSupervisor({ ...f.identity, process_id: 901, protocol_version: 1, origin: 'local-parent-v1' });
    assert.equal((await attempt(compose(h.migrator, roles.migrator))).outcome, 'KNOWN_FAILURE');
    await q(`GRANT INSERT ON ${s}.evolution_supervisors TO "${roles.issuer}"`);
    try { assert.equal((await attempt(compose())).outcome, 'KNOWN_FAILURE'); }
    finally { await q(`REVOKE INSERT ON ${s}.evolution_supervisors FROM "${roles.issuer}"`); }
    // Membership is introduced only as a negative fixture; never for legitimate identity separation.
    await h.membership(roles.executor, roles.issuer, true);
    try {
      assert.equal((await attempt(compose())).outcome, 'KNOWN_FAILURE');
      const client = await issuer.connect();
      try {
        await client.query(`SET ROLE "${roles.executor}"`);
        const identity = (await client.query('SELECT session_user,current_user')).rows[0];
        assert.equal(identity.session_user, roles.issuer); assert.equal(identity.current_user, roles.executor);
        const boundPool = { connect: async () => ({ connectionParameters: client.connectionParameters,
          query: (...args) => client.query(...args), release() {} }) };
        assert.equal((await attempt(compose(boundPool))).outcome, 'KNOWN_FAILURE');
      } finally { await client.query('RESET ROLE'); client.release(); }
    } finally { await h.membership(roles.executor, roles.issuer, false); }
    assert.deepEqual(await controlSnapshot(), before);
  });

  const f = await candidate(2, issuer, { conversationManaged: true });
  const business = await h.significantBusiness(f), beforeBusiness = await snapshot();
  const [valid] = await payloads(f);

  await t.test('A02/C03: a second authenticated issuer cannot certify another issuer birth/closure/proof', async () => {
    const b = compose(adversary, roles.adversary);
    assert.equal((await b.authority.registerSupervisor({ ...b.identity, process_id: 903, protocol_version: 1, origin: 'local-parent-v1' })).outcome, 'CONFIRMED');
    const before = await controlSnapshot();
    await assert.rejects(adversary.query(`SELECT ${s}.studiofy_advance_executor_gate($1,$2,$3,'DRAINING')`,
      [f.birth.executor_id, f.birth.boot_id, f.supervisor.supervisor_id]), { code: '23514' });
    const closure = await closurePayload(f);
    await assert.rejects(adversary.query(`SELECT ${s}.studiofy_accept_executor_closure($1::jsonb)`, [JSON.stringify(closure)]), { code: '23514' });
    await assert.rejects(adversary.query(proofSql, [JSON.stringify(valid)]), { code: '23514' });
    assert.equal((await b.authority.listExecutionSubjects({ executor_id: f.birth.executor_id, boot_id: f.birth.boot_id, limit: 100 })).outcome, 'KNOWN_FAILURE');
    assert.throws(() => b.authority.registerExecutorBirth(f.birth), { code: 'SQL031_INPUT_INVALID' });
    assert.deepEqual(await controlSnapshot(), before);
  });

  const crossed = {
    tenant: { assinatura_id: '985999' }, instance: { instance_name: 'synthetic-crossed' }, executor: { executor_id: randomUUID() },
    boot: { boot_id: randomUUID() }, execution: { execution_id: f.executions[1] }, claim: { claim_token: randomUUID() },
    schema: { source_schema: 'test_' + 'f'.repeat(32) }, fingerprint: { operation_token_fingerprint: 'sha256:' + '0'.repeat(64) },
    token: { operation_token: randomUUID() }, supervisor: { supervisor_id: randomUUID() },
  };
  for (const [dimension, change] of Object.entries(crossed)) {
    await t.test('A03/A04/D02: atomic rejection of crossed ' + dimension, async () => {
      const before = await controlSnapshot();
      await assert.rejects(issuer.query(proofSql, [JSON.stringify({ ...valid, ...change })]), { code: '23514' });
      assert.deepEqual(await controlSnapshot(), before); assert.deepEqual(await snapshot(), beforeBusiness);
    });
  }

  await t.test('D03: missing/extra/null/type/version payloads have no partial acceptance', async () => {
    const missing = { ...valid }; delete missing.execution_id;
    const variants = [missing, { ...valid, subjects: [] }, { ...valid, execution_id: null },
      { ...valid, execution_id: 7 }, { ...valid, protocol_version: 2 }];
    const before = await controlSnapshot();
    for (const value of variants) {
      await assert.rejects(issuer.query(proofSql, [JSON.stringify(value)]), error => ['23514', '22P02', '23502', 'P0002'].includes(error.code));
      assert.deepEqual(await controlSnapshot(), before);
    }
  });

  await t.test('B01/C01/D01: gate cannot bypass drain, reopen, regress, or accept proof without closure', async () => {
    const g = await candidate(0, issuer, { close: false });
    const gateState = async () => (await q(`SELECT state FROM ${s}.evolution_executor_gates WHERE executor_id=$1`, [g.birth.executor_id])).rows[0].state;
    const advance = state => issuer.query(`SELECT ${s}.studiofy_advance_executor_gate($1,$2,$3,$4)`, [g.birth.executor_id, g.birth.boot_id, g.supervisor.supervisor_id, state]);
    await assert.rejects(advance('CLOSED'), { code: '23514' }); assert.equal(await gateState(), 'OPEN');
    const closure = { ...await closurePayload(f), closure_event_id: randomUUID(), idempotency_key: randomUUID(),
      executor_id: g.birth.executor_id, boot_id: g.birth.boot_id, supervisor_id: g.supervisor.supervisor_id, supervisor_boot_id: g.supervisor.supervisor_boot_id };
    await assert.rejects(issuer.query(`SELECT ${s}.studiofy_accept_executor_closure($1::jsonb)`, [JSON.stringify(closure)]), { code: '23514' });
    await assert.rejects(issuer.query(proofSql, [JSON.stringify({ ...valid, closure_event_id: randomUUID() })]), { code: 'P0002' });
    await advance('DRAINING'); await assert.rejects(advance('OPEN'), { code: '23514' }); assert.equal(await gateState(), 'DRAINING');
    assert.equal((await g.gate.close()).outcome, 'CONFIRMED');
    for (const state of ['OPEN', 'DRAINING']) await assert.rejects(advance(state), { code: '23514' });
    assert.equal(await gateState(), 'CLOSED');
  });

  await t.test('D02/H01/H02: individual STOP leaves B and all uncertain transport/business snapshots untouched', async () => {
    assert.equal(business.length, 2);
    assert.equal(beforeBusiness.evolution_delivery_reconciliations.length, 2);
    assert.equal(beforeBusiness.whatsapp_conversations.length, 2);
    assert.equal(beforeBusiness.whatsapp_conversation_responses.length, 4);
    assert.equal(beforeBusiness.whatsapp_conversation_inbox.length, 4);
    for (const link of business) {
      const delivery = beforeBusiness.whatsapp_messages.find(x => String(x.row.id) === String(link.delivery_id)).row;
      assert.equal(delivery.status, 'uncertain'); assert.ok(delivery.attempts > 0); assert.equal(delivery.sent_at, null);
      assert.equal(delivery.conversation_managed, true);
      assert.equal(delivery.operation_token, link.operation_token); assert.equal(delivery.claim_token, link.claim_token);
      const disposition = beforeBusiness.evolution_delivery_reconciliations.find(x => x.row.receipt_key === link.receipt).row;
      assert.equal(disposition.outcome, 'abandoned_unknown'); assert.equal(disposition.operation_token, link.operation_token);
      assert.equal(String(disposition.delivery_id), String(link.delivery_id)); assert.equal(disposition.claim_token, link.claim_token);
      const owner = beforeBusiness.evolution_instance_owners.find(x => x.row.operation_token === link.operation_token);
      assert.ok(owner);
      const pending = beforeBusiness.whatsapp_messages.find(x => String(x.row.id) === String(link.pending_delivery)).row;
      assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 0); assert.equal(pending.sent_at, null);
      assert.equal(pending.conversation_managed, true);
      const ordered = beforeBusiness.whatsapp_conversation_inbox.filter(x => x.row.conversation_id === link.conversation)
        .map(x => x.row).sort((a, b) => BigInt(a.received_order) < BigInt(b.received_order) ? -1 : 1);
      assert.deepEqual(ordered.map(x => String(x.received_order)), link.order.map(String));
      assert.ok(ordered.every(x => String(x.expected_response_id) === String(link.delivery_id) && x.decision === 'awaiting_delivery'));
    }
    assert.match(valid.operation_token_fingerprint, /^sha256:[a-f0-9]{64}$/);
    const sqlBefore = await controlSnapshot();
    const authorizations = async () => (await q(`SELECT to_jsonb(a) AS row FROM ${s}.evolution_execution_authorizations a ORDER BY execution_id`)).rows;
    const authorizationBefore = await authorizations();
    let sends = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { sends++; throw Error('Transport forbidden in STOP test'); };
    try {
      await issuer.query(proofSql, [JSON.stringify(valid)]);
      assert.equal((await lifecycle(valid.execution_id)).lifecycle_state, 'STOPPED');
      assert.equal((await lifecycle(f.executions[1])).lifecycle_state, 'UNKNOWN');
      assert.deepEqual(await snapshot(), beforeBusiness);
      const sqlAfter = await controlSnapshot();
      for (const table of h.ledger.filter(name => !['evolution_execution_stop_proofs', 'evolution_execution_stops'].includes(name))) {
        assert.deepEqual(sqlAfter[table], sqlBefore[table]);
      }
      assert.equal(sqlAfter.evolution_execution_stop_proofs.length, sqlBefore.evolution_execution_stop_proofs.length + 1);
      assert.equal(sqlAfter.evolution_execution_stops.length, sqlBefore.evolution_execution_stops.length + 1);
      const authorizationAfter = await authorizations();
      assert.equal(authorizationAfter.length, authorizationBefore.length);
      for (let i = 0; i < authorizationBefore.length; i++) {
        const before = authorizationBefore[i].row, after = authorizationAfter[i].row;
        if (before.execution_id !== valid.execution_id) assert.deepEqual(after, before);
        else {
          assert.equal(after.state, 'UNKNOWN');
          assert.deepEqual({ ...after, state: before.state, revoked_at: before.revoked_at, updated_at: before.updated_at }, before);
        }
      }
      const rows = (await q(`SELECT DISTINCT status FROM ${s}.whatsapp_messages WHERE status<>'pending'`)).rows;
      // This guards only fetch. The exercised STOP path is a direct SQL031 call, not a transport adapter.
      assert.deepEqual(rows, [{ status: 'uncertain' }]); assert.equal(sends, 0);
    } finally { global.fetch = originalFetch; }
  });

  for (const stage of ['supervisor', 'birth', 'OPEN', 'DRAINING', 'closure']) {
    await t.test('E01/E02: real control COMMIT ACK loss at ' + stage + ' is terminal', async () => {
      const seed = await candidate(0, issuer, { open: false, close: false });
      const { createControlSqlRunner } = require('../services/supervision/sql031Transactions');
      const { createDormantSql031Gate } = require('../services/supervision/sql031GateIntegration');
      const supervisor = { ...seed.supervisor, supervisor_id: randomUUID(), supervisor_boot_id: randomUUID() };
      const birth = { ...seed.birth, executor_id: randomUUID(), boot_id: randomUUID(), spawn_id: randomUUID(),
        supervisor_id: supervisor.supervisor_id, supervisor_boot_id: supervisor.supervisor_boot_id };
      const runner = createControlSqlRunner({ pool: injected, authority: 'SUPERVISOR_PROOF_ISSUER', issuerLogin: roles.issuer,
        migratorLogin: roles.migrator, executorLogin: roles.executor, schema: h.schema, database: h.database, localTestOnly: true });
      const gate = createDormantSql031Gate({ transactionRunner: runner, supervisor, birth, requiredCapabilities: ['listener'] });
      gate.executor.registerCapability('listener', () => {}); fault.loseStage = stage;
      let result = await gate.bootstrap();
      if (result.outcome === 'CONFIRMED') result = await gate.open();
      if (result.outcome === 'CONFIRMED') result = await gate.close();
      assert.equal(result.outcome, 'UNKNOWN'); assert.equal(runner.snapshot().blocked, true);
      const calls = fault.queries, n = await controlSnapshot();
      for (const op of ['bootstrap', 'open', 'close']) assert.equal((await gate[op]()).outcome, 'UNKNOWN');
      assert.throws(() => gate.createStopProjection()); assert.equal(fault.queries, calls);
      assert.deepEqual(await controlSnapshot(), n);
    });
  }

  await t.test('E01/E02/F01: A confirmed, B committed with ACK lost, C untouched; no read-and-retry', async () => {
    const g = await candidate(3, injected), cap = g.gate.createStopProjection(), before = await snapshot();
    fault.loseAt = fault.calls + 2;
    const result = await cap.certifyNextPage();
    assert.equal(result.outcome, 'UNKNOWN'); assert.equal(result.value.cursor, g.executions[0]);
    assert.deepEqual(result.value.confirmed.map(x => x.execution_id), [g.executions[0]]);
    assert.equal((await lifecycle(g.executions[0])).lifecycle_state, 'STOPPED');
    // Observer-only read: persisted B does not grant the runtime knowledge of COMMIT.
    assert.equal((await lifecycle(g.executions[1])).lifecycle_state, 'STOPPED');
    assert.equal((await lifecycle(g.executions[2])).lifecycle_state, 'UNKNOWN');
    assert.equal(cap.snapshot().attempt.execution_id, g.executions[1]);
    const calls = fault.queries, attempt = cap.snapshot().attempt;
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(await cap.certifyNextPage(), result); assert.strictEqual(g.gate.createStopProjection(), cap);
      assert.strictEqual(cap.snapshot().attempt, attempt);
    }
    assert.equal(fault.queries, calls); assert.equal(fault.sql.at(-1), 'COMMIT');
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('G01: timeout and absent heartbeat expire authorization without lifecycle STOPPED', async () => {
    const g = await candidate(1, issuer, { close: false });
    // Wait for the real database deadline. No schema/function/lease rewriting.
    await q(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (lease_until-clock_timestamp())))::double precision+0.05)
      FROM ${s}.evolution_execution_authorizations WHERE execution_id=$1`, [g.executions[0]]);
    const auth = (await q(`SELECT authorization_state FROM ${s}.evolution_execution_authorization_status WHERE execution_id=$1`, [g.executions[0]])).rows[0];
    assert.equal(auth.authorization_state, 'UNKNOWN');
    assert.equal((await lifecycle(g.executions[0])).lifecycle_state, 'UNKNOWN');
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_execution_stops WHERE execution_id=$1`, [g.executions[0]])).rows[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_executor_closure_events WHERE executor_id=$1`, [g.birth.executor_id])).rows[0].n, 0);
  });

  await t.test('J01: synthetic uncertain legacy execution cannot be retroactively adopted', async () => {
    const legacy = { executor_id: randomUUID(), boot_id: randomUUID() }, owner = compose();
    await owner.authority.registerSupervisor({ ...owner.identity, protocol_version: 1, process_id: 904, origin: 'local-parent-v1' });
    await q(`INSERT INTO ${s}.evolution_executors(executor_id,boot_id,process_id,started_at) VALUES($1,$2,905,clock_timestamp())`, [legacy.executor_id, legacy.boot_id]);
    const tenant = 986001, instance = 'synthetic-legacy-adversarial', token = randomUUID(), claim = randomUUID(), execution = randomUUID();
    await q(`INSERT INTO ${s}.assinaturas(id,barbearia_nome,responsavel_nome,telefone,metodo_pagamento,dia_vencimento,suporte_numero,whatsapp_session)
      VALUES($1,'Synthetic','Synthetic','11999990000','mercado_pago',5,'',$2)`, [tenant, instance]);
    await q(`UPDATE ${s}.evolution_instance_owners SET operation_token=$1,operation_started_at=clock_timestamp() WHERE owner_id=$2`, [token, String(tenant)]);
    const delivery = (await q(`INSERT INTO ${s}.whatsapp_messages(assinatura_id,instance,phone,message_id,response,status,claim_token,operation_token,claimed_at)
      VALUES($1,$2,'5511999990000',$3,'Synthetic','sending',$4,$5,clock_timestamp()) RETURNING id`, [tenant, instance, randomUUID(), claim, token])).rows[0].id;
    await q(`INSERT INTO ${s}.evolution_operation_executions(execution_id,executor_id,operation_token,assinatura_id,instance_name,operation_kind,delivery_id,claim_token)
      VALUES($1,$2,$3,$4,$5,'whatsapp_messages',$6,$7)`, [execution, legacy.executor_id, token, tenant, instance, delivery, claim]);
    await q(`UPDATE ${s}.whatsapp_messages SET dispatch_started_at=clock_timestamp(),attempts=attempts+1 WHERE id=$1`, [delivery]);
    await q(`UPDATE ${s}.whatsapp_messages SET status='uncertain' WHERE id=$1`, [delivery]);
    const before = await snapshot();
    const messageBefore = before.whatsapp_messages.find(x => String(x.row.id) === String(delivery)).row;
    assert.equal(messageBefore.status, 'uncertain'); assert.ok(messageBefore.attempts > 0);
    assert.equal(messageBefore.sent_at, null); assert.notEqual(messageBefore.dispatch_started_at, null);
    assert.equal(messageBefore.operation_token, token); assert.equal(messageBefore.claim_token, claim);
    assert.ok(before.evolution_instance_owners.some(x => x.row.operation_token === token && x.row.owner_id === String(tenant)));
    const tokenFingerprint = async () => (await q(`SELECT
      'sha256:'||encode(sha256(convert_to('studiofy.operation-token.v1:'||operation_token::text,'UTF8')),'hex') AS fingerprint
      FROM ${s}.evolution_operation_executions WHERE execution_id=$1`, [execution])).rows[0].fingerprint;
    const fingerprintBefore = await tokenFingerprint();
    assert.match(fingerprintBefore, /^sha256:[a-f0-9]{64}$/);
    const assertNotAdopted = async () => {
      for (const table of ['evolution_executor_birth_bindings', 'evolution_executor_gates',
        'evolution_executor_closure_events', 'evolution_execution_stop_proofs']) {
        assert.equal((await q(`SELECT count(*)::int n FROM ${s}.${table} WHERE executor_id=$1`, [legacy.executor_id])).rows[0].n, 0, table);
      }
      assert.equal((await q(`SELECT count(*)::int n FROM ${s}.evolution_execution_stops WHERE execution_id=$1`, [execution])).rows[0].n, 0);
      // SQL031 legacy/unbound is independent of migration030 lease authorization;
      // transport UNKNOWN does not imply authorization UNKNOWN.
      const state = (await lifecycle(execution)).lifecycle_state;
      assert.notEqual(state, 'STOPPED'); assert.ok(['ACTIVE', 'UNKNOWN'].includes(state));
    };
    await assertNotAdopted();
    assert.equal((await owner.authority.registerExecutorBirth({ ...f.birth, ...legacy, ...owner.identity, spawn_id: randomUUID() })).outcome, 'KNOWN_FAILURE');
    assert.equal((await owner.authority.listExecutionSubjects({ ...legacy, limit: 100 })).outcome, 'KNOWN_FAILURE');
    const closure = { ...await closurePayload(f), ...legacy, ...owner.identity, closure_event_id: randomUUID(), idempotency_key: randomUUID() };
    await assert.rejects(issuer.query(`SELECT ${s}.studiofy_accept_executor_closure($1::jsonb)`, [JSON.stringify(closure)]));
    await assert.rejects(issuer.query(proofSql, [JSON.stringify({ ...valid, ...legacy, execution_id: execution })]));
    const after = await snapshot();
    assert.deepEqual(after, before);
    assert.equal(after.whatsapp_messages.find(x => String(x.row.id) === String(delivery)).row.status, 'uncertain');
    assert.equal(await tokenFingerprint(), fingerprintBefore);
    await assertNotAdopted();
  });
});
