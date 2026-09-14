const money = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const displayDate = value => value.split('-').reverse().join('/');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const MENU = 'Olá! 👋\nBem-vindo ao nosso salão.\n\nComo posso te ajudar?\n\n1 - Realizar agendamento\n2 - Ver preços\n3 - Ver endereço\n4 - Cancelar agendamento\n\nDigite o número da opção desejada.';
const numbered = (items, label) => items.map((item, index) => `${index + 1} - ${label(item)}`).join('\n');
const pick = (items, input) => /^[1-9]\d*$/.test(input) ? items?.[Number(input) - 1] : undefined;

// The adapter owns persistence and scheduling. A transition runs in its transaction.
async function transition(adapter, tenant, phone, previous, input) {
  let session = structuredClone(previous || { state: 'MENU' });
  const command = normalize(input);
  const reply = text => { session.prompt = text; return { session, text }; };
  const menu = (prefix = '') => { session = { state: 'MENU' }; return reply(prefix + MENU); };
  const invalid = () => ({ session, text: `Não consegui entender. 😅\nEscolha uma das opções abaixo:\n\n${session.prompt || MENU}` });
  const services = async () => {
    session.services = await adapter.services(tenant);
    session.state = 'ESCOLHENDO_SERVICO';
    return reply(session.services.length ? `✂️ Qual serviço você deseja?\n\n${numbered(session.services, s => `${s.name} - ${money(s.price)}`)}\n\n0 - Voltar ao menu` : 'Nenhum serviço cadastrado no momento.\n0 - Voltar ao menu');
  };
  const dates = async () => {
    session.dates = await adapter.dates(tenant, session.service);
    session.state = 'ESCOLHENDO_DATA';
    return reply(session.dates.length ? `📅 Qual dia você deseja?\n\n${numbered(session.dates, d => displayDate(d))}\n\n0 - Voltar ao menu` : 'Não há datas disponíveis no período de agendamento.\n0 - Voltar ao menu');
  };
  const times = async (prefix = '') => {
    session.times = await adapter.times(tenant, session.date, session.service);
    session.state = 'ESCOLHENDO_HORARIO';
    if (!session.times.length) { const result = await dates(); result.text = `${prefix}Não há mais horários nesse dia.\n\n${result.text}`; return result; }
    return reply(`${prefix}🕐 Escolha um horário:\n\n${numbered(session.times, t => t)}\n\n0 - Voltar ao menu`);
  };
  const summary = () => `👤 Cliente: ${session.name}\n✂️ Serviço: ${session.service.name}\n💰 Valor: ${money(session.service.price)}\n📅 Data: ${displayDate(session.date)}\n🕐 Horário: ${session.time}`;
  const confirm = () => { session.state = 'CONFIRMANDO'; return reply(`📋 Resumo do agendamento\n\n${summary()}\n\nEstá tudo correto?\n\n1 - Confirmar agendamento\n2 - Alterar serviço\n3 - Alterar data\n4 - Alterar horário\n5 - Cancelar`); };
  const cancellation = () => { session.state = 'CONFIRMAR_CANCELAMENTO'; return reply(`Deseja cancelar este agendamento?\n\n✂️ ${session.appointment.name}\n📅 ${displayDate(session.appointment.date)}\n🕐 ${session.appointment.time}\n\n1 - Sim, cancelar\n2 - Não`); };

  if (['menu', 'cancelar', 'recomecar'].includes(command) || input === '0') return menu();
  if (!previous || (session.state === 'MENU' && ['oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'quero marcar', 'agendamento'].includes(command))) return menu();
  switch (session.state) {
    case 'MENU':
      if (input === '1') return services();
      if (input === '2') { session.state = 'INFORMACAO'; const list = await adapter.services(tenant); return reply(`💰 Nossos serviços:\n\n${numbered(list, s => `${s.name} - ${money(s.price)}`) || 'Nenhum serviço cadastrado.'}\n\n0 - Voltar ao menu`); }
      if (input === '3') { session.state = 'INFORMACAO'; return reply(`📍 ${await adapter.address(tenant) || 'O endereço ainda não foi configurado pelo salão.'}\n\n0 - Voltar ao menu`); }
      if (input === '4') {
        session.appointments = await adapter.future(tenant, phone);
        if (!session.appointments.length) return menu('Não encontrei agendamentos futuros para seu número.\n\n');
        if (session.appointments.length === 1) { session.appointment = session.appointments[0]; return cancellation(); }
        session.state = 'CANCELANDO_AGENDAMENTO';
        return reply(`Qual agendamento deseja cancelar?\n\n${numbered(session.appointments, a => `${a.name} - ${displayDate(a.date)} às ${a.time}`)}\n\n0 - Voltar ao menu`);
      }
      return invalid();
    case 'ESCOLHENDO_SERVICO': {
      const selected = pick(session.services, input);
      if (!selected) return invalid();
      const current = (await adapter.services(tenant)).find(s => s.id === selected.id);
      if (!current) return services();
      session.service = current; delete session.date; delete session.time;
      return dates();
    }
    case 'ESCOLHENDO_DATA': {
      const selected = pick(session.dates, input);
      if (!selected) return invalid();
      session.date = selected; delete session.time;
      return times();
    }
    case 'ESCOLHENDO_HORARIO': {
      const selected = pick(session.times, input);
      if (!selected) return invalid();
      session.time = selected;
      session.name = session.name || await adapter.knownName(tenant, phone);
      if (session.name) return confirm();
      session.state = 'AGUARDANDO_NOME';
      return reply('👤 Para finalizar, qual é o seu nome?');
    }
    case 'AGUARDANDO_NOME':
      if (input.length < 2 || input.length > 100 || !/\p{L}/u.test(input) || /[<>\r\n@]/.test(input)) return { session, text: 'Informe seu nome (2 a 100 caracteres). Você também pode digitar MENU.' };
      session.name = input;
      return confirm();
    case 'CONFIRMANDO':
      if (input === '2') return services();
      if (input === '3') return dates();
      if (input === '4') return times();
      if (input === '5') return menu('Processo de agendamento cancelado.\n\n');
      if (input !== '1') return invalid();
      {
        const current = (await adapter.services(tenant)).find(s => s.id === session.service.id);
        if (!current) return services();
        if (current.price !== session.service.price || current.name !== session.service.name) { session.service = current; return confirm(); }
        if (!(await adapter.times(tenant, session.date, session.service)).includes(session.time)) return times('⚠️ Esse horário acabou de ficar indisponível.\n\n');
        const booked = await adapter.book(tenant, phone, session);
        if (!booked) return times('⚠️ Esse horário acabou de ficar indisponível.\n\n');
        const text = `✅ Agendamento confirmado!\n\n${summary()}\n\nSeu horário foi reservado com sucesso. 😊\n\nDigite MENU para voltar.`;
        session = { state: 'MENU' }; return reply(text);
      }
    case 'CANCELANDO_AGENDAMENTO':
      session.appointment = pick(session.appointments, input);
      return session.appointment ? cancellation() : invalid();
    case 'CONFIRMAR_CANCELAMENTO':
      if (input === '2') return menu();
      if (input !== '1') return invalid();
      return menu(await adapter.cancel(tenant, phone, session.appointment.id) ? '✅ Agendamento cancelado com sucesso.\n\n' : 'Este agendamento já foi cancelado ou não está mais no futuro.\n\n');
    default: return invalid();
  }
}

module.exports = { transition, MENU };
