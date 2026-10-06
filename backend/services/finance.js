// Input must come from the authenticated establishment's scoped appointment query.
function financialSummary(appointments, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;
  const monday = new Date(`${today}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const weekStart = monday.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const history = appointments.filter(a => a.status === 'concluido' &&
    (a.data < today || (a.data === today && a.hora <= time)))
    .map(a => ({ id: a.id, data: a.data, hora: a.hora, cliente: a.nome_cliente,
      servico_id: a.studio_service_id, servico: a.servico_nome, profissional: a.profissional,
      valor_centavos: Math.round(Number(a.preco || 0) * 100) }))
    .sort((a, b) => b.data.localeCompare(a.data) || b.hora.localeCompare(a.hora) || b.id - a.id);
  const total = rows => ({ atendimentos: rows.length,
    valor_centavos: rows.reduce((sum, a) => sum + a.valor_centavos, 0) });
  const services = new Map();
  const months = new Map();
  for (const a of history) {
    const month = a.data.slice(0, 7);
    const monthly = months.get(month) || { mes: month, atendimentos: 0, valor_centavos: 0 };
    monthly.atendimentos++;
    monthly.valor_centavos += a.valor_centavos;
    months.set(month, monthly);
    const key = a.servico_id ? `id:${a.servico_id}` : `nome:${a.servico}`;
    const service = services.get(key) || { servico: a.servico, atendimentos: 0, valor_centavos: 0 };
    service.atendimentos++;
    service.valor_centavos += a.valor_centavos;
    services.set(key, service);
  }
  return {
    referencia: today, inicio_semana: weekStart, inicio_mes: monthStart,
    hoje: total(history.filter(a => a.data === today)),
    semana: total(history.filter(a => a.data >= weekStart)),
    mes: total(history.filter(a => a.data >= monthStart)),
    total: total(history),
    meses: [...months.values()],
    servicos: [...services.values()].sort((a, b) => b.atendimentos - a.atendimentos ||
      b.valor_centavos - a.valor_centavos || a.servico.localeCompare(b.servico)),
    historico: history,
  };
}

module.exports = { financialSummary };
