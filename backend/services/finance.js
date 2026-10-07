const { localMoment, appointmentPermissions } = require('./agenda');

// Invalid legacy prices are excluded, including fractions of a cent (1.005).
// Parse decimal digits rather than rounding binary floating point amounts.
function historicalCents(value) {
  if (!['number', 'string'].includes(typeof value)) return null;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2] || '').slice(2).replace(/0/g, '')) return null;
  const cents = BigInt(match[1]) * 100n + BigInt(((match[2] || '') + '00').slice(0, 2));
  return cents <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cents) : null;
}

function sumCents(rows) {
  const sum = rows.reduce((total, row) => total + BigInt(row.valor_centavos), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Financial total exceeds safe integer range.');
  return Number(sum);
}

// Input must come from the authenticated establishment's scoped appointment query.
function financialSummary(appointments, now = new Date()) {
  const moment = localMoment(now), today = moment.date;
  const monday = new Date(`${today}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const weekStart = monday.toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';
  const history = appointments.filter(a => a.status === 'concluido' &&
    appointmentPermissions({ ...a, status: 'confirmado' }, moment).pode_concluir &&
    historicalCents(a.preco) !== null)
    .map(a => ({ id: a.id, data: a.data, hora: a.hora, cliente: a.nome_cliente,
      servico_id: a.studio_service_id, servico: typeof a.servico_nome === 'string' && a.servico_nome.trim()
        ? a.servico_nome : 'Serviço não identificado', profissional: a.profissional,
      valor_centavos: historicalCents(a.preco) }))
    .sort((a, b) => b.data.localeCompare(a.data) || b.hora.localeCompare(a.hora) || b.id - a.id);
  const total = rows => ({ atendimentos: rows.length,
    valor_centavos: sumCents(rows) });
  // Check the complete sum before calculating any numeric subtotals.
  const historicalTotal = total(history);
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
    total: historicalTotal,
    meses: [...months.values()],
    servicos: [...services.values()].sort((a, b) => b.atendimentos - a.atendimentos ||
      b.valor_centavos - a.valor_centavos || a.servico.localeCompare(b.servico)),
    historico: history,
  };
}

// Preserve all legacy selectors. Missing periodo historically meant all history.
function financialPeriod(query = {}, now = new Date()) {
  const period = query.periodo === undefined ? 'total' : query.periodo;
  const reference = localMoment(now).date;
  const aliases = { dia: 'hoje', hoje: 'hoje', semana: 'semana', mes: 'mes', ano: 'ano',
    mes_customizado: 'mes', total: 'total', historico: 'total' };
  const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (typeof period !== 'string' || !Object.hasOwn(aliases, period)) invalid('Período inválido.');
  if (query.mes !== undefined && (aliases[period] !== 'mes' || typeof query.mes !== 'string' ||
      !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(query.mes))) invalid('Mês inválido. Use YYYY-MM para o período mensal.');
  if (period === 'mes_customizado' && query.mes === undefined) invalid('Informe o mês no formato YYYY-MM.');
  return { period: aliases[period], month: query.mes ?? reference.slice(0, 7), year: reference.slice(0, 4) };
}

function periodTotal(summary, selector) {
  if (selector.period === 'mes') return sumCents(summary.historico.filter(a => a.data.slice(0, 7) === selector.month));
  if (selector.period === 'ano') return sumCents(summary.historico.filter(a => a.data.slice(0, 4) === selector.year));
  return summary[selector.period].valor_centavos;
}

module.exports = { financialSummary, historicalCents, financialPeriod, periodTotal };
