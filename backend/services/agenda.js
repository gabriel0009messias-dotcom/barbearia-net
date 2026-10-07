function localMoment(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function appointmentTime(appointment, moment = localMoment()) {
  const date = appointment.data, time = appointment.hora;
  const valid = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date &&
    typeof time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return { valid, future: valid && (date > moment.date || (date === moment.date && time > moment.time)) };
}

function appointmentPermissions(appointment, moment = localMoment()) {
  const { valid, future } = appointmentTime(appointment, moment);
  const reason = !valid ? 'Data ou horário do atendimento inválido.' :
    future ? 'Não é permitido concluir um atendimento futuro.' :
    appointment.status !== 'confirmado' ? 'Somente um atendimento agendado pode ser concluído.' : null;
  return { futuro: future, pode_concluir: !reason, motivo_conclusao: reason };
}

function appointmentId(value) {
  if (!['number', 'string'].includes(typeof value) || !/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw Object.assign(new Error('Informe um ID de agendamento válido.'), { statusCode: 400 });
  }
  return Number(value);
}

const conflict = message => { throw Object.assign(new Error(message), { statusCode: 409 }); };
function assertTransition(appointment, status, moment = localMoment()) {
  if (!['confirmado', 'concluido', 'cancelado', 'falta'].includes(status)) {
    throw Object.assign(new Error('Status inválido.'), { statusCode: 400 });
  }
  if (appointment.status !== 'confirmado') conflict('Este atendimento está encerrado e não permite alteração de status.');
  if (status === 'concluido') {
    const permission = appointmentPermissions(appointment, moment);
    if (!permission.pode_concluir) conflict(permission.motivo_conclusao);
  }
  if (status === 'falta') {
    const { valid, future } = appointmentTime(appointment, moment);
    if (!valid) conflict('Data ou horário do atendimento inválido.');
    if (future) conflict('Não é permitido registrar falta antes do horário inicial do atendimento.');
  }
}

function assertReschedule(appointment, moment = localMoment()) {
  if (appointment.status !== 'confirmado') conflict('Somente um atendimento agendado pode ser remarcado. Atendimentos encerrados são preservados.');
  const { valid, future } = appointmentTime(appointment, moment);
  if (!valid || !future) conflict('A remarcação só é permitida antes do horário inicial do atendimento.');
}

async function transitionAppointment(db, tenant, id, status, clock = () => new Date()) {
  id = appointmentId(id);
  if (db.transaction) return db.transaction(connection => transitionAppointment(connection, tenant, id, status, clock));
  const appointment = await db.getAsync('SELECT * FROM agendamentos WHERE id=$1 AND assinatura_id=$2 FOR UPDATE', [id, tenant]);
  if (!appointment) throw Object.assign(new Error('Agendamento não encontrado.'), { statusCode: 404 });
  assertTransition(appointment, status, localMoment(clock()));
  // Compare the persisted state as well as holding the row lock; callers cannot reopen a final state.
  const result = await db.runAsync("UPDATE agendamentos SET status=$1 WHERE id=$2 AND assinatura_id=$3 AND status='confirmado'", [status, id, tenant]);
  if (!result.changes) conflict('O estado do agendamento mudou. Atualize a Agenda.');
}

module.exports = { localMoment, appointmentPermissions, appointmentId, assertTransition, assertReschedule, transitionAppointment };
