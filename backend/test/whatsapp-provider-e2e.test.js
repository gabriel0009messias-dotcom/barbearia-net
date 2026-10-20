const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/conversation');

test('provider PN: inbound through booking, durable confirmation, single delivery, lookup and cancellation', async t => {
  const env = require('./helpers/postgres').testEnvironment();
  process.env.EVOLUTION_WEBHOOK_SECRET = 'conversation-test-secret';
  const db = require('../database'); await db.ready;
  t.after(async () => { await db.close(); await env.cleanup(); });
  // Synthetic 12-digit Brazilian PN: 55 + DDD + eight-digit mobile.
  // Never store a personal incident number in fixtures or test output.
  const phone = '551188887777';
  const f = await fixture(db, { known: false });
  const customer = () => db.getAsync('SELECT id,nome,telefone FROM clientes WHERE assinatura_id=$1 AND telefone=$2',[f.tenant,phone]);
  const event = f.payload('oi',{phone,id:'provider-e2e-inbound'});
  event.data.key.remoteJid = '123456789012345@lid';
  event.data.key.remoteJidAlt = phone + '@s.whatsapp.net';
  const inbound = await f.webhook.processarWebhookEvolution(event,f.headers,{deferDelivery:true});
  assert.equal(inbound.ignored,undefined);
  const captured = await db.getAsync('SELECT * FROM whatsapp_conversation_captures WHERE instance_key=$1 AND message_id=$2',[f.instance,event.data.key.id]);
  assert.equal(captured.decision,'processed'); assert.equal(captured.assinatura_id,f.tenant);
  assert.equal(captured.sender,phone); assert.equal((await f.state(phone)).state.step,'ASK_NAME');
  const original = await customer(); assert.equal(original.telefone,phone);
  await f.webhook.drain(f.sendMock);
  await f.send('Cliente Sintetico',{phone});
  const review = await f.review(phone);
  assert.equal(review.state.step,'REVIEW');
  const { date, time } = review.state;
  const completion = await f.send('1',{phone,drain:false});
  assert.equal(completion.state.state.step,'COMPLETE');
  const id = completion.state.state.appointmentId;
  const appointment = await db.getAsync('SELECT * FROM agendamentos WHERE id=$1',[id]);
  assert.equal(appointment.telefone,phone); assert.equal(appointment.cliente_id,original.id);
  assert.equal(appointment.assinatura_id,f.tenant); assert.equal(appointment.origem,'whatsapp');
  const origin = await db.getAsync('SELECT * FROM public_booking_access WHERE appointment_id=$1',[id]);
  assert.equal(origin.confirmation_snapshot.phone_state,'routable');
  assert.equal(origin.confirmation_snapshot.telefone,phone);
  assert.equal(origin.confirmation_snapshot.phone_identity,'whatsapp');
  assert.equal(origin.confirmation_blocked_reason,null);
  assert.equal(origin.confirmation_materialized_at,null);

  const confirmations = require('../services/bookingConfirmation');
  await confirmations.materializeBookingConfirmations(db);
  const outbox = await db.getAsync('SELECT * FROM whatsapp_messages WHERE booking_confirmation_appointment_id=$1',[id]);
  assert.ok(outbox); assert.equal(outbox.status,'pending'); assert.equal(outbox.phone,phone);
  assert.equal(await confirmations.validateBookingConfirmation(db,outbox),true);
  const delivery = require('../services/evolutionDelivery'), create = delivery.createEvolutionDelivery;
  let frontiers = 0, sends = 0;
  t.mock.method(delivery,'createEvolutionDelivery',(...args) => {
    const actual = create(...args), dispatch = actual.dispatch;
    actual.dispatch = async (table,row,...rest) => {
      if (row.booking_confirmation_appointment_id === id) frontiers++;
      return dispatch(table,row,...rest);
    };
    return actual;
  });
  const transport = async (instance,destination,text) => {
    sends++; assert.equal(instance,f.instance); assert.equal(destination,phone);
    assert.match(text,/agendamento foi confirmado/);
    const intent = await db.getAsync('SELECT * FROM whatsapp_messages WHERE id=$1',[outbox.id]);
    assert.equal(intent.status,'sending'); assert.ok(intent.dispatch_started_at);
    assert.ok(intent.operation_token); assert.equal(intent.attempts,1);
    return {key:{id:'provider-e2e-confirmation'},status:'PENDING'};
  };
  await f.webhook.drain(transport);
  assert.equal(frontiers,1); assert.equal(sends,1);
  assert.equal((await db.getAsync('SELECT status FROM whatsapp_messages WHERE id=$1',[outbox.id])).status,'sent');
  assert.equal((await f.webhook.processarWebhookEvolution(completion.event,f.headers,{deferDelivery:true})).duplicate,true);
  await confirmations.materializeBookingConfirmations(db);
  await f.webhook.drain(transport);
  assert.equal(sends,1);
  assert.equal((await db.getAsync('SELECT count(*)::int n FROM whatsapp_messages WHERE booking_confirmation_appointment_id=$1',[id])).n,1);
  assert.equal((await customer()).id,original.id);

  const access = require('../services/publicBookings').createPublicBookings(db);
  const others = await fixture(db,{known:false});
  assert.deepEqual(await access.forContact(others.tenant,phone),[]);
  await assert.rejects(access.cancelForContact(others.tenant,phone,id),e=>e.statusCode===404);
  await assert.rejects(access.cancelForContact(f.tenant,'5511988887777',id),e=>e.statusCode===404);
  assert.deepEqual((await access.forContact(f.tenant,phone)).map(x=>x.id),[id]);
  await f.send('menu',{phone});
  const listed = await f.send('4',{phone});
  assert.equal(listed.state.state.step,'CANCEL');
  assert.deepEqual(listed.state.state.options.map(x=>x.id),[id]);
  assert.equal((await f.send('1',{phone})).state.state.step,'CANCEL_REVIEW');
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[id])).status,'confirmado');
  await f.send('1',{phone});
  assert.equal((await db.getAsync('SELECT status FROM agendamentos WHERE id=$1',[id])).status,'cancelado');
  assert.deepEqual(await access.forContact(f.tenant,phone),[]);
  const slots = await require('../services/studiofy').createStudio(db).times(f.tenant,date,f.service,f.professional);
  assert.ok(slots.includes(time));
  await f.send('oi',{phone});
  assert.equal((await f.state(phone)).state.step,'MENU');
  assert.equal((await customer()).id,original.id);
  assert.equal(require('../services/whatsapp/phone').normalizeBrazilianDestination(phone),null);

  // Neither request JSON nor an unbound action ID grants provider authority.
  const { confirmBooking } = require('../services/bookingRequests');
  const body = {nome_cliente:'Cliente Publico',telefone:phone,servico_id:f.service,
    profissional_id:f.professional,data:date,hora:time,phone_identity:'whatsapp',conversation_action_id:origin.confirmation_snapshot.conversation_action_id};
  await assert.rejects(db.transaction(c => confirmBooking(c,require('../services/studiofy').createStudio(c),f.tenant,
    body,require('node:crypto').randomBytes(32).toString('hex'),require('node:crypto').randomUUID())),e=>e.statusCode===400);
  const publicBooking = await db.transaction(c => confirmBooking(c,require('../services/studiofy').createStudio(c),f.tenant,body));
  const publicOrigin = await db.getAsync('SELECT * FROM public_booking_access WHERE token_hash=$1',
    [require('node:crypto').createHash('sha256').update(publicBooking.token).digest('hex')]);
  assert.equal(publicOrigin.confirmation_snapshot.phone_identity,'public');
  assert.equal(publicOrigin.confirmation_snapshot.phone_state,'invalid');
  await confirmations.materializeBookingConfirmations(db);
  assert.equal((await db.getAsync('SELECT confirmation_blocked_reason FROM public_booking_access WHERE appointment_id=$1',[publicOrigin.appointment_id])).confirmation_blocked_reason,'invalid_phone');
  assert.equal(await db.getAsync('SELECT id FROM whatsapp_messages WHERE booking_confirmation_appointment_id=$1',[publicOrigin.appointment_id]),undefined);
});
