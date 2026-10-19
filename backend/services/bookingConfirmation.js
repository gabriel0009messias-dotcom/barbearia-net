const { historicalCents } = require('./finance');
const { normalizeInstanceName } = require('./evolutionOwnership');
const { normalizeBrazilianDestination } = require('./whatsapp/phone');

const plain = value => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';

function buildBookingConfirmation(snapshot) {
  const cliente = plain(snapshot?.cliente), estabelecimento = plain(snapshot?.estabelecimento), servico = plain(snapshot?.servico);
  const cents = historicalCents(snapshot?.preco);
  const date = snapshot?.data, hour = snapshot?.hora;
  if (!cliente || !estabelecimento || !servico || cents === null ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(Date.parse(date + 'T12:00:00Z')) ||
      new Date(date + 'T12:00:00Z').toISOString().slice(0, 10) !== date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(hour || '')) {
    throw new Error('Invalid booking confirmation snapshot.');
  }
  const amount = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
  return `Olá, ${cliente}! 👋\n\nSeu agendamento foi confirmado.\n\nEstabelecimento: ${estabelecimento}\nServiço: ${servico}${plain(snapshot.profissional) ? '\nProfissional: ' + plain(snapshot.profissional) : ''}\nValor: ${amount}\nData: ${date.split('-').reverse().join('/')}\nHorário: ${hour}\n\nAté lá! 😊`;
}

// SQL-only, inside the booking transaction. No provider, resolver or transport
// participates in booking. IDs are obtained from the inserted appointment,
// never from the request body. Phone routing is decided from the original field
// BEFORE studio.book: do not copy its legacy-normalized telephone as a destination.
// Only genuinely new public bookings call this.
async function captureBookingConfirmation(db, tenant, appointmentId, phoneRouting = { state: 'missing', destination: null }) {
  if (!Number.isSafeInteger(tenant) || tenant <= 0 || !Number.isSafeInteger(appointmentId) || appointmentId <= 0) throw new Error('Invalid booking confirmation identity.');
  if (!phoneRouting || !['routable', 'invalid', 'missing'].includes(phoneRouting.state) ||
      (phoneRouting.state === 'routable'
        ? !phoneRouting.destination || normalizeBrazilianDestination(phoneRouting.destination) !== phoneRouting.destination
        : phoneRouting.destination !== null)) throw new Error('Invalid booking confirmation phone decision.');
  const result = await db.runAsync(`UPDATE public_booking_access p SET confirmation_snapshot=jsonb_build_object(
    'appointment_id',a.id::text,'assinatura_id',a.assinatura_id::text,'cliente',a.nome_cliente,'telefone',$3::text,'phone_state',$4::text,
    'servico',a.servico_nome,'preco',a.preco,'data',a.data,'hora',a.hora,'estabelecimento',s.barbearia_nome,'instance',s.whatsapp_session,
    'profissional',(SELECT nome FROM profissionais WHERE id=a.profissional_id AND assinatura_id=a.assinatura_id))
    FROM agendamentos a JOIN assinaturas s ON s.id=a.assinatura_id
    WHERE p.appointment_id=a.id AND a.id=$1 AND a.assinatura_id=$2 AND p.confirmation_snapshot IS NULL`, [appointmentId, tenant, phoneRouting.destination, phoneRouting.state]);
  if (result.changes !== 1) throw new Error('Booking confirmation origin mismatch.');
}

async function validateBookingConfirmation(db, row) {
  const current = await db.getAsync(`SELECT a.*,p.confirmation_snapshot FROM agendamentos a
    JOIN public_booking_access p ON p.appointment_id=a.id WHERE a.id=$1 AND a.assinatura_id=$2`,
    [row.booking_confirmation_appointment_id, row.assinatura_id]);
  const snapshot = current?.confirmation_snapshot;
  return Boolean(snapshot && snapshot.phone_state === 'routable' && snapshot.telefone === row.phone &&
    normalizeBrazilianDestination(snapshot.telefone) === snapshot.telefone && current.status === 'confirmado' && String(current.id) === snapshot.appointment_id &&
    String(current.assinatura_id) === snapshot.assinatura_id && current.nome_cliente === snapshot.cliente &&
    normalizeBrazilianDestination(current.telefone) === row.phone && current.servico_nome === snapshot.servico &&
    historicalCents(current.preco) === historicalCents(snapshot.preco) && current.data === snapshot.data && current.hora === snapshot.hora);
}

// Called by the EXISTING outbox worker. READ COMMITTED cannot see a source
// until the booking commits. Row lock + unique appointment key + atomic marker
// make repeated/concurrent/restarted materialization converge to one delivery.
async function materializeBookingConfirmations(db, { limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid confirmation batch.');
  for (let i = 0; i < limit; i++) {
    const found = await db.transaction(async client => {
      const origin = await client.getAsync(`SELECT p.appointment_id,p.confirmation_snapshot,a.assinatura_id
        FROM public_booking_access p JOIN agendamentos a ON a.id=p.appointment_id
        WHERE p.confirmation_snapshot IS NOT NULL AND p.confirmation_materialized_at IS NULL
          AND p.confirmation_blocked_reason IS NULL ORDER BY p.created_at,p.appointment_id
        LIMIT 1 FOR UPDATE OF p SKIP LOCKED`);
      if (!origin) return false;
      const snapshot = origin.confirmation_snapshot;
      let reason = null, response, instance;
      // Consume the immutable decision. Never retry normalization of a rejected
      // original field using the appointment's transformed legacy telephone.
      const phone = snapshot.phone_state === 'routable' && snapshot.telefone &&
        normalizeBrazilianDestination(snapshot.telefone) === snapshot.telefone ? snapshot.telefone : null;
      if (!phone) reason = 'invalid_phone';
      try { instance = normalizeInstanceName(snapshot.instance); if (!instance) reason ||= 'instance_not_configured'; else if (instance !== snapshot.instance) reason ||= 'instance_invalid'; }
      catch { reason ||= 'instance_invalid'; }
      try { response = buildBookingConfirmation(snapshot); } catch { reason ||= 'invalid_snapshot'; }
      if (String(origin.appointment_id) !== snapshot.appointment_id || String(origin.assinatura_id) !== snapshot.assinatura_id) reason ||= 'invalid_snapshot';
      if (!reason && !await validateBookingConfirmation(client, {
        booking_confirmation_appointment_id: origin.appointment_id, assinatura_id: origin.assinatura_id, phone,
      })) reason = 'appointment_changed';
      if (reason) {
        await client.runAsync('UPDATE public_booking_access SET confirmation_blocked_reason=$1 WHERE appointment_id=$2', [reason, origin.appointment_id]);
        return true;
      }
      await client.runAsync(`INSERT INTO whatsapp_messages(assinatura_id,instance,phone,message_id,response,booking_confirmation_appointment_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (booking_confirmation_appointment_id)
        WHERE booking_confirmation_appointment_id IS NOT NULL DO NOTHING`,
        [origin.assinatura_id, instance, phone, 'booking_confirmation:' + origin.appointment_id, response, origin.appointment_id]);
      await client.runAsync('UPDATE public_booking_access SET confirmation_materialized_at=CURRENT_TIMESTAMP WHERE appointment_id=$1', [origin.appointment_id]);
      return true;
    }, { serialize: false });
    if (!found) return;
  }
}

module.exports = { buildBookingConfirmation, captureBookingConfirmation, materializeBookingConfirmations, validateBookingConfirmation };
