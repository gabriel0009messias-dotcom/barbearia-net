const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Pool } = require('pg');
const { fixture, accepted } = require('./helpers/returnOutbox');
const { createReturnReminderWorker, materializeReturnReminders, validateReturnReminder, inProcessingWindow } = require('../services/returnReminders');
const { composeMessage } = require('../services/returnReminderDispatcher');
const { createEvolutionDelivery } = require('../services/evolutionDelivery');

test('return outbox: transactional producer and unchanged delivery protocol', { timeout: 180000 }, async t => {
  const f = await fixture(t), { db, q, get, s } = f;
  const materialize = () => materializeReturnReminders(db);
  const delivery = createEvolutionDelivery(db, { timeoutMs: 3000 });
  let sends = 0;
  const send = async () => { sends++; return accepted(); };
  const dispatch = async (r, validate = () => validateReturnReminder(db, { return_reminder_id: r.id, assinatura_id: r.assinatura_id }), transport = send) =>
    delivery.dispatch('whatsapp_messages', await f.claim(r), transport, { validate });

  await t.test('durable activation defaults off; producer refuses every custom dispatcher', async () => {
    const { r } = await f.opportunity();
    assert.equal(await get("SELECT valor FROM configuracoes WHERE chave='return_outbox_delivery_enabled'"), undefined);
    assert.equal((await get('SELECT studiofy_return_delivery_open() ready')).ready, false);
    assert.deepEqual(await materialize(), []); assert.equal(await f.outbox(r), undefined);
    assert.throws(() => createReturnReminderWorker(db, { dispatcher: { dispatch: send } }));
    assert.throws(() => createReturnReminderWorker(db, { schema: 'bad;schema' }));
    assert.throws(() => createReturnReminderWorker(db, { limit: 51 }));
    await f.enable();
  });
  await t.test('server snapshot captures completion, tenant, normalized phone and original establishment', async () => {
    const { owner, sid, r } = await f.opportunity();
    const a = await get('SELECT * FROM agendamentos WHERE id=$1', [r.appointment_id]);
    assert.equal(r.transport_protocol, 'outbox_v1'); assert.equal(r.historical_snapshot_status, 'captured');
    assert.equal(a.return_history_snapshot.assinatura_id, String(owner.id));
    assert.equal(a.return_history_snapshot.telefone, r.phone_snapshot);
    assert.equal(+new Date(a.return_history_snapshot.completed_at), +r.completed_at);
    await q("UPDATE assinaturas SET barbearia_nome='Nome atual diferente' WHERE id=$1", [owner.id]);
    await q("UPDATE servicos_assinatura SET nome='Catálogo renomeado' WHERE id=$1", [sid]);
    await materialize(); const m = await f.outbox(r);
    assert.match(m.response, /Ágata histórica/); assert.match(m.response, /Serviço histórico/);
    assert.match(m.response, /Estabelecimento histórico/); assert.doesNotMatch(m.response, /Nome atual|Catálogo/);
    assert.match(m.response, /Já faz 7 dias desde seu atendimento/);
    assert.equal(m.message_id, 'return_reminder:' + r.id); assert.equal(m.conversation_managed, false);
    assert.equal(m.booking_confirmation_appointment_id, null); assert.ok(m.return_owner_epoch);
    assert.equal(await composeMessage(db, r.id), m.response);
    await dispatch(r); const source = await f.row(r), result = await f.outbox(r);
    assert.equal(source.status, 'pending'); assert.equal(source.attempts, 0); assert.equal(source.sent_at, null);
    assert.equal(result.status, 'sent'); assert.equal(result.attempts, 1); assert.ok(result.sent_at);
    assert.equal((await get('SELECT delivery_status FROM return_reminder_delivery WHERE id=$1', [r.id])).delivery_status, 'sent');
    const before = sends; await materialize(); await delivery.recoverInterrupted('whatsapp_messages');
    assert.equal((await f.outbox(r)).id, m.id); assert.equal(sends, before);
    await assert.rejects(q("UPDATE whatsapp_messages SET status='pending' WHERE id=$1", [m.id]), e => e.code === '23514');
  });
  await t.test('missing historical establishment never borrows a future name or generates a reminder later', async () => {
    const owner = await f.account(), sid = await f.service(owner);
    await q("UPDATE assinaturas SET barbearia_nome='' WHERE id=$1", [owner.id]);
    const id = await f.book(owner, sid); await q("UPDATE agendamentos SET status='concluido' WHERE id=$1", [id]);
    assert.equal((await get('SELECT return_history_snapshot FROM agendamentos WHERE id=$1', [id])).return_history_snapshot.estabelecimento, null);
    assert.equal((await get('SELECT historical_snapshot_status FROM return_reminders WHERE appointment_id=$1', [id])).historical_snapshot_status, 'unavailable_at_completion');
    await q("UPDATE assinaturas SET barbearia_nome='New unrelated name' WHERE id=$1", [owner.id]);
    await q("UPDATE agendamentos SET status='concluido' WHERE id=$1", [id]); await materialize();
    assert.equal((await get('SELECT historical_snapshot_status FROM return_reminders WHERE appointment_id=$1', [id])).historical_snapshot_status, 'unavailable_at_completion');
  });
  await t.test('parallel producers with independent pools and restart converge on one durable binding', async () => {
    const { r } = await f.opportunity();
    const pool = new Pool(require('../database/config').connectionConfig());
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => materializeReturnReminders(i % 2 ? { pool, ready: Promise.resolve() } : db)));
      await materialize();
      assert.equal((await get('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id=$1', [r.id])).n, 1);
      assert.ok((await f.row(r)).materialized_at);
    } finally { await pool.end(); }
  });
  await t.test('two separate OS processes converge, including process restart', async () => {
    const { r } = await f.opportunity();
    const code = `const db=require('./database');(async()=>{await db.ready;await require('./services/returnReminders').materializeReturnReminders(db);await db.close();})().catch(e=>{console.error(e);process.exitCode=1;});`;
    await Promise.all([f.child(code).done, f.child(code).done]); await f.child(code).done;
    assert.equal((await get('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id=$1', [r.id])).n, 1);
  });
  await t.test('crash after outbox INSERT before source marker rolls both back; restart materializes once', async () => {
    const { r } = await f.opportunity();
    const child = f.child(`const db=require('./database');(async()=>{await db.ready;const c=await db.pool.connect();await c.query('BEGIN');
      const r=(await c.query('SELECT * FROM return_reminders WHERE id=$1',[${r.id}])).rows[0];
      await c.query('SELECT studiofy_return_group_lock($1,$2,$3)',[r.assinatura_id,r.customer_key,r.service_identity]);
      await c.query(\`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,return_reminder_id,return_owner_epoch)
        SELECT r.assinatura_id,a.whatsapp_session,r.phone_snapshot,'return_reminder:'||r.id,studiofy_return_message_text(r),r.id,o.conversation_epoch
        FROM return_reminders r JOIN assinaturas a ON a.id=r.assinatura_id JOIN evolution_instance_owners o ON o.owner_id=a.id::text
        WHERE r.id=$1\`,[r.id]);process.send('staged');})().catch(e=>{console.error(e);process.exit(1);});`);
    assert.deepEqual(await once(child, 'message'), ['staged', undefined]);
    assert.equal(await f.outbox(r), undefined); assert.equal((await f.row(r)).materialized_at, null);
    child.kill(); await assert.rejects(child.done);
    await materialize(); assert.ok((await f.outbox(r)).id); assert.ok((await f.row(r)).materialized_at);
    await materialize(); assert.equal((await get('SELECT count(*)::int n FROM whatsapp_messages WHERE return_reminder_id=$1', [r.id])).n, 1);
  });
  await t.test('SQL failure updating the materialization marker rolls back the INSERT', async () => {
    const { r } = await f.opportunity();
    await q(`CREATE FUNCTION return_test_marker_failure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.id=${r.id} AND NEW.materialized_at IS NOT NULL THEN RAISE EXCEPTION 'Synthetic marker failure';END IF;RETURN NEW;END$$`);
    await q('CREATE TRIGGER return_test_marker_failure BEFORE UPDATE ON return_reminders FOR EACH ROW EXECUTE FUNCTION return_test_marker_failure()');
    try { await assert.rejects(materialize(), /Synthetic marker failure/); assert.equal(await f.outbox(r), undefined); }
    finally { await q('DROP TRIGGER return_test_marker_failure ON return_reminders'); await q('DROP FUNCTION return_test_marker_failure()'); }
    await materialize(); assert.ok(await f.outbox(r));
  });
  await t.test('microsecond eligibility is evaluated by PostgreSQL without rounding up', async () => {
    const { r } = await f.opportunity();
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE OR REPLACE FUNCTION ${s}.studiofy_return_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
        SELECT eligible_at-interval '1 microsecond' FROM ${s}.return_reminders WHERE id=${r.id}$$`);
      assert.equal((await c.query(`SELECT ${s}.studiofy_return_rule_ready(r) ready FROM return_reminders r WHERE id=$1`, [r.id])).rows[0].ready, false);
      await c.query(`CREATE OR REPLACE FUNCTION ${s}.studiofy_return_now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
        SELECT eligible_at FROM ${s}.return_reminders WHERE id=${r.id}$$`);
      assert.equal((await c.query(`SELECT ${s}.studiofy_return_rule_ready(r) ready FROM return_reminders r WHERE id=$1`, [r.id])).rows[0].ready, true);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  await t.test('09:00 inclusive and 18:00 exclusive, UTC midnight and historical DST use São Paulo', async () => {
    for (const [iso, expected] of [['2030-06-03T11:59:59.999Z', false], ['2030-06-03T12:00:00Z', true],
      ['2030-06-03T20:59:59.999Z', true], ['2030-06-03T21:00:00Z', false], ['2030-06-04T00:00:00Z', false],
      ['2018-12-03T11:00:00Z', true], ['2018-12-03T20:00:00Z', false]]) {
      await f.clock(iso); assert.equal((await get('SELECT studiofy_return_delivery_open() ready')).ready, expected, iso);
      assert.equal(inProcessingWindow(new Date(iso)), expected, iso);
    }
    await f.clock();
  });
  await t.test('materialized returns defer outside the window or when disabled without consuming an attempt', async () => {
    for (const disabled of [false, true]) {
      await f.clock(); await f.enable(); const { r } = await f.opportunity(); await materialize();
      if (disabled) await f.enable(false); else await f.clock('2030-06-03T21:00:00Z');
      const before = sends; await dispatch(r);
      const m = await f.outbox(r); assert.equal(m.status, 'pending'); assert.equal(m.attempts, 0);
      assert.equal(m.dispatch_started_at, null); assert.equal(m.operation_token, null); assert.equal(sends, before);
      assert.equal((await get('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(r.assinatura_id)])).operation_token, null);
    }
    await f.clock(); await f.enable();
  });
  await t.test('missing ownership defers materialization; newly configured ownership can recover', async () => {
    const { owner, r } = await f.opportunity({ instance: null }); await materialize();
    assert.equal(await f.outbox(r), undefined); assert.equal((await f.row(r)).status, 'pending');
    await q("UPDATE assinaturas SET whatsapp_session='return-recovered-test' WHERE id=$1", [owner.id]);
    await f.clock('2030-06-03T15:02:00Z'); await materialize(); assert.ok(await f.outbox(r)); await f.clock();
  });
  await t.test('inactive catalog service cancels before materialization and blocks at the frontier', async () => {
    const first = await f.opportunity(); await q('UPDATE servicos_assinatura SET ativo=false WHERE id=$1', [first.sid]);
    await materialize(); assert.equal((await f.row(first.r)).status, 'cancelled'); assert.equal(await f.outbox(first.r), undefined);
    const second = await f.opportunity(); await materialize(); await q('UPDATE servicos_assinatura SET ativo=false WHERE id=$1', [second.sid]);
    const before = sends; await dispatch(second.r); assert.equal((await f.outbox(second.r)).status, 'failed'); assert.equal(sends, before);
  });
  await t.test('suppression before materialization never creates a transport for the older source', async () => {
    const { owner, sid, r } = await f.opportunity(); await f.complete(owner, sid); await materialize();
    assert.equal((await f.row(r)).status, 'suppressed'); assert.equal(await f.outbox(r), undefined);
  });
  await t.test('suppression after materialization fails only pending outbox and retains its binding', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); const m = await f.outbox(r);
    await f.complete(owner, sid);
    assert.equal((await f.row(r)).status, 'suppressed'); assert.equal((await f.outbox(r)).status, 'failed');
    assert.equal((await f.outbox(r)).id, m.id); assert.equal((await f.outbox(r)).attempts, 0);
  });
  await t.test('concurrent native conclusions and producers leave only the newest group opportunity eligible', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize();
    const ids = await Promise.all([f.book(owner, sid), f.book(owner, sid), f.book(owner, sid)]);
    await Promise.all(ids.map(id => q("UPDATE agendamentos SET status='concluido' WHERE id=$1", [id])));
    await Promise.all([materialize(), materialize()]);
    const rows = (await q('SELECT * FROM return_reminders WHERE assinatura_id=$1 ORDER BY completed_at DESC,appointment_id DESC', [owner.id])).rows;
    assert.equal(rows.length, 4); assert.equal(rows[0].status, 'pending');
    assert.ok(rows.slice(1).every(row => row.status === 'suppressed'));
    assert.equal((await f.outbox(r)).status, 'failed'); assert.ok(await f.outbox(rows[0]));
    for (const row of rows.slice(1)) assert.equal((await get('SELECT studiofy_return_rule_ready(r) ready FROM return_reminders r WHERE id=$1', [row.id])).ready, false);
    const before = sends; await dispatch(rows[0]); assert.equal(sends, before + 1);
  });
  await t.test('suppression of reserved sending row leaves operation ownership to the delivery finalizer', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); const before = sends;
    await dispatch(r, async () => {
      const reserved = await f.outbox(r); assert.ok(reserved.operation_token);
      await f.complete(owner, sid);
      const suppressed = await f.outbox(r); assert.equal(suppressed.operation_token, reserved.operation_token);
      assert.equal(suppressed.status, 'sending'); return validateReturnReminder(db, suppressed);
    });
    const m = await f.outbox(r); assert.equal(m.status, 'failed'); assert.equal(sends, before);
    assert.equal((await f.row(r)).status, 'suppressed');
    assert.equal((await get('SELECT operation_token FROM evolution_instance_owners WHERE owner_id=$1', [String(owner.id)])).operation_token, null);
  });
  await t.test('SQL revalidation rejects supersession committed after a stale successful callback', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); const before = sends;
    await dispatch(r, async () => { await f.complete(owner, sid); return true; });
    const m = await f.outbox(r); assert.equal(sends, before); assert.equal(m.dispatch_started_at, null); assert.equal(m.attempts, 0);
    assert.equal(m.status, 'pending'); assert.equal((await get('SELECT studiofy_return_outbox_ready(m) ready FROM whatsapp_messages m WHERE id=$1', [m.id])).ready, false);
  });
  for (const lock of ['group', 'source', 'catalog']) await t.test('frontier acquires no inverse ' + lock + ' lock', async () => {
    const { sid, r } = await f.opportunity(); await materialize(); const c = await db.pool.connect(); const before = sends;
    try {
      await c.query('BEGIN');
      if (lock === 'group') await f.group(c, r);
      else await c.query(`SELECT id FROM ${lock === 'source' ? 'return_reminders' : 'servicos_assinatura'} WHERE id=$1 FOR UPDATE`, [lock === 'source' ? r.id : sid]);
      await dispatch(r, async () => true);
      assert.equal(sends, before + 1); assert.equal((await f.outbox(r)).status, 'sent');
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
  await t.test('post-frontier completion preserves accepted delivery and does not fake source suppression', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize();
    await dispatch(r, undefined, async () => {
      assert.ok((await f.outbox(r)).dispatch_started_at); await f.complete(owner, sid); return accepted();
    });
    assert.equal((await f.outbox(r)).status, 'sent'); assert.equal((await f.row(r)).status, 'pending');
    assert.equal((await get('SELECT studiofy_return_rule_ready(r) ready FROM return_reminders r WHERE id=$1', [r.id])).ready, false);
  });
  await t.test('no transaction, group lock or source/outbox/account row lock crosses the transport callback', async () => {
    const { owner, r } = await f.opportunity(); await materialize();
    await dispatch(r, undefined, async () => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        assert.equal((await c.query('SELECT pg_try_advisory_xact_lock(studiofy_return_group_key($1,$2,$3)) locked',
          [r.assinatura_id, r.customer_key, r.service_identity])).rows[0].locked, true);
        await c.query('SELECT id FROM return_reminders WHERE id=$1 FOR UPDATE NOWAIT', [r.id]);
        await c.query('SELECT id FROM whatsapp_messages WHERE return_reminder_id=$1 FOR UPDATE NOWAIT', [r.id]);
        await c.query('SELECT id FROM assinaturas WHERE id=$1 FOR UPDATE NOWAIT', [owner.id]);
      } finally { await c.query('ROLLBACK'); c.release(); }
      return accepted();
    });
    assert.equal((await f.outbox(r)).status, 'sent');
  });
  for (const disable of [false, true]) await t.test('PostgreSQL frontier defers a late ' + (disable ? 'feature disable' : '18:00 boundary') + ' after successful callback', async () => {
    const { r } = await f.opportunity(); await materialize(); const before = sends;
    await dispatch(r, async () => { if (disable) await f.enable(false); else await f.clock('2030-06-03T21:00:00Z'); return true; });
    assert.equal(sends, before); const m = await f.outbox(r);
    assert.equal(m.status, 'pending'); assert.equal(m.attempts, 0); assert.equal(m.dispatch_started_at, null); assert.equal(m.operation_token, null);
    await f.clock(); await f.enable();
  });
  for (const outcome of ['accepted', 'rejected', 'not_accepted']) await t.test('uncertain is never retried blindly; explicit ' + outcome + ' reconciliation is idempotent', async () => {
    const { owner, sid, r } = await f.opportunity(); await materialize(); const before = sends;
    await dispatch(r, undefined, async () => { sends++; throw Error('Synthetic lost provider acknowledgement'); });
    const m = await f.outbox(r); assert.equal(m.status, 'uncertain'); assert.equal(m.attempts, 1); assert.ok(m.operation_token);
    await materialize(); await delivery.recoverInterrupted('whatsapp_messages'); assert.equal(sends, before + 1);
    assert.equal((await f.outbox(r)).status, 'uncertain');
    await assert.rejects(delivery.reconcile('whatsapp_messages', m.id, owner.id, m.operation_token, { outcome }));
    await assert.rejects(delivery.reconcile('whatsapp_messages', m.id, owner.id + 10000, m.operation_token, { stopped: true, outcome }));
    if (outcome === 'not_accepted') await f.complete(owner, sid);
    await delivery.reconcile('whatsapp_messages', m.id, owner.id, m.operation_token, { stopped: true, outcome });
    await delivery.reconcile('whatsapp_messages', m.id, owner.id, m.operation_token, { stopped: true, outcome });
    assert.equal((await f.outbox(r)).status, outcome === 'accepted' ? 'sent' : outcome === 'rejected' ? 'failed' : 'pending');
    assert.equal((await get('SELECT count(*)::int n FROM evolution_delivery_reconciliations WHERE delivery_id=$1', [m.id])).n, 1);
    if (outcome === 'not_accepted') { await dispatch(r); assert.equal(sends, before + 1); assert.equal((await f.outbox(r)).status, 'failed'); }
  });
  await t.test('restart recovers an unstarted claim without increasing attempts and sends only once', async () => {
    const { r } = await f.opportunity(); await materialize(); const m = await f.claim(r);
    await q("UPDATE whatsapp_messages SET claimed_at=clock_timestamp()-interval '3 minutes' WHERE id=$1", [m.id]);
    await delivery.recoverInterrupted('whatsapp_messages'); assert.equal((await f.outbox(r)).status, 'pending');
    assert.equal((await f.outbox(r)).attempts, 0); await dispatch(r); assert.equal((await f.outbox(r)).status, 'sent');
  });
  for (const frontier of [false, true]) await t.test('killed worker process at ' + (frontier ? 'transport frontier becomes uncertain' : 'reservation is safely recoverable'), async () => {
    const { owner, r } = await f.opportunity(); await materialize(); const m = await f.claim(r);
    const child = f.child(`const db=require('./database');(async()=>{await db.ready;
      const row=await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[${m.id}]);
      const pause=async()=>{process.send('paused');await new Promise(()=>{});};
      await require('./services/evolutionDelivery').createEvolutionDelivery(db).dispatch('whatsapp_messages',row,
        ${frontier ? 'pause' : 'async()=>{throw Error("Unexpected transport");}'},
        {validate:${frontier ? 'async()=>true' : 'pause'}});await db.close();})().catch(e=>{console.error(e);process.exit(1);});`);
    await once(child, 'message');
    const staged = await f.outbox(r); assert.ok(staged.operation_token); assert.equal(Boolean(staged.dispatch_started_at), frontier);
    child.kill(); await assert.rejects(child.done);
    await delivery.recoverInterrupted('whatsapp_messages', new Date(Date.now() + 1000));
    const recovered = await f.outbox(r);
    assert.equal(recovered.status, frontier ? 'uncertain' : 'pending'); assert.equal(recovered.attempts, frontier ? 1 : 0);
    if (frontier) {
      await delivery.reconcile('whatsapp_messages', m.id, owner.id, recovered.operation_token, { stopped: true, outcome: 'accepted' });
      assert.equal((await f.outbox(r)).status, 'sent');
    } else { assert.equal(recovered.operation_token, null); await dispatch(r); assert.equal((await f.outbox(r)).status, 'sent'); }
  });
  await t.test('ownership A→B→A changes epoch and never authorizes the stale materialized payload', async () => {
    const { owner, r } = await f.opportunity(); await materialize(); const m = await f.outbox(r);
    const b = await f.account({ instance: null });
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [owner.id]);
    await q('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', [m.instance, b.id]);
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [b.id]);
    await q('UPDATE assinaturas SET whatsapp_session=$1 WHERE id=$2', [m.instance, owner.id]);
    const epoch = (await get('SELECT conversation_epoch FROM evolution_instance_owners WHERE owner_id=$1', [String(owner.id)])).conversation_epoch;
    assert.notEqual(epoch, m.return_owner_epoch); const before = sends;
    await dispatch(r, async () => true); assert.equal(sends, before); assert.equal((await f.outbox(r)).attempts, 0);
    await assert.rejects(q('UPDATE whatsapp_messages SET return_owner_epoch=$1 WHERE id=$2', [epoch, m.id]), e => e.code === '23514');
  });
  await t.test('wrong tenant or reassigned instance fails before transport', async () => {
    const { owner, r } = await f.opportunity(); await materialize(); const m = await f.outbox(r), b = await f.account();
    assert.equal(await validateReturnReminder(db, { ...m, assinatura_id: b.id }), false);
    await assert.rejects(q('UPDATE whatsapp_messages SET assinatura_id=$1 WHERE id=$2', [b.id, m.id]), e => e.code === '23514');
    await q('UPDATE assinaturas SET whatsapp_session=NULL WHERE id=$1', [owner.id]);
    const before = sends; await dispatch(r); assert.equal((await f.outbox(r)).status, 'failed'); assert.equal(sends, before);
  });
  await t.test('payload, historical snapshots, markers and source materialization are immutable', async () => {
    const { r } = await f.opportunity(); await materialize(); const m = await f.outbox(r);
    for (const set of ["response='adulterado'", "phone='5511988886060'", "message_id='other'", 'return_reminder_id=NULL',
      'return_owner_epoch=gen_random_uuid()', 'booking_confirmation_appointment_id=123', 'conversation_managed=true'])
      await assert.rejects(q('UPDATE whatsapp_messages SET ' + set + ' WHERE id=$1', [m.id]), e => e.code === '23514');
    for (const set of ["return_history_snapshot='{}'::jsonb", 'completed_at=clock_timestamp()'])
      await assert.rejects(q('UPDATE agendamentos SET ' + set + ' WHERE id=$1', [r.appointment_id]), e => e.code === '23514');
    for (const set of ["establishment_name_snapshot='inventado'", "transport_protocol='legacy_simulated'", 'materialized_at=NULL', 'attempts=1', "status='processing'"])
      await assert.rejects(db.transaction(async c => {
        await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
        await c.runAsync('UPDATE return_reminders SET ' + set + ' WHERE id=$1', [r.id]);
      }), e => e.code === '23514');
  });
  await t.test('forged INSERT payload, foreign tenant, duplicate instance and historical snapshot all fail closed', async () => {
    const { r } = await f.opportunity(); await materialize(); const m = await f.outbox(r), b = await f.account();
    const insert = `INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,return_reminder_id,return_owner_epoch)
      VALUES($1,$2,$3,$4,$5,$6,$7)`;
    const values = [m.assinatura_id, m.instance, m.phone, m.message_id, m.response, m.return_reminder_id, m.return_owner_epoch];
    for (const [column, value] of [[0, b.id], [1, b.whatsapp_session], [4, 'Fabricated historical message']]) {
      const forged = values.slice(); forged[column] = value;
      await assert.rejects(db.transaction(async c => {
        await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
        await c.runAsync(insert, forged);
      }), e => ['23503', '23505', '23514'].includes(e.code));
    }
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
      await c.runAsync(insert, values);
    }), e => e.code === '23505');
    await assert.rejects(q(`INSERT INTO agendamentos(assinatura_id,nome_cliente,telefone,servico_nome,data,hora,status,return_history_snapshot)
      VALUES($1,'Forged','11999996060','Fake','2020-01-01','10:00','concluido','{}'::jsonb)`, [r.assinatura_id]), e => e.code === '23514');
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
      await c.runAsync(`INSERT INTO return_reminders(assinatura_id,appointment_id,service_identity,customer_key,customer_name_snapshot,
        phone_snapshot,service_name_snapshot,completed_at,eligible_at,next_attempt_at,transport_protocol,historical_snapshot_status,establishment_name_snapshot,historical_snapshot_at,snapshot_version)
        SELECT assinatura_id,appointment_id,service_identity,customer_key,customer_name_snapshot,phone_snapshot,service_name_snapshot,
        completed_at,eligible_at,next_attempt_at,'outbox_v1','captured','Invented establishment',completed_at,1 FROM return_reminders WHERE id=$1`, [r.id]);
    }), e => e.code === '23514');
  });
  await t.test('delete/recreate cannot erase outbox identity, including same-transaction recreation', async () => {
    const { r } = await f.opportunity(); await materialize(); const m = await f.outbox(r);
    await assert.rejects(q('DELETE FROM whatsapp_messages WHERE id=$1', [m.id]), e => e.code === '23514');
    await assert.rejects(db.transaction(async c => {
      await c.runAsync('SELECT studiofy_return_group_lock($1,$2,$3)', [r.assinatura_id, r.customer_key, r.service_identity]);
      await c.runAsync('DELETE FROM whatsapp_messages WHERE id=$1', [m.id]);
      await c.runAsync(`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,return_reminder_id,return_owner_epoch)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [m.assinatura_id, m.instance, m.phone, m.message_id, m.response, m.return_reminder_id, m.return_owner_epoch]);
    }), e => e.code === '23514');
    assert.equal((await f.outbox(r)).id, m.id);
    await assert.rejects(q('DELETE FROM return_reminders WHERE id=$1', [r.id]), e => ['23503', '23514'].includes(e.code));
  });
  await t.test('complete account deletion can remove both source and outbox atomically', async () => {
    const { owner, r } = await f.opportunity(); await materialize(); assert.ok(await f.outbox(r));
    await db.transaction(async c => { await c.runAsync('DELETE FROM whatsapp_messages WHERE assinatura_id=$1', [owner.id]);
      await c.runAsync('DELETE FROM agendamentos WHERE assinatura_id=$1', [owner.id]); await c.runAsync('DELETE FROM assinaturas WHERE id=$1', [owner.id]); });
    assert.equal(await f.outbox(r), undefined); assert.equal(await f.row(r), undefined);
  });
});
