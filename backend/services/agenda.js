function localMoment(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function appointmentPermissions(appointment, moment = localMoment()) {
  const future = appointment.data > moment.date ||
    (appointment.data === moment.date && appointment.hora > moment.time);
  const reason = future ? 'Não é permitido concluir um atendimento futuro.' :
    appointment.status !== 'confirmado' ? 'Somente um atendimento agendado pode ser concluído.' : null;
  return { futuro: future, pode_concluir: !reason, motivo_conclusao: reason };
}

module.exports = { localMoment, appointmentPermissions };
