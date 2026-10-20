const crypto = require('node:crypto');
const { createStudio, effectiveHours } = require('../studiofy');
const { publicProfile } = require('../establishment');
const { localNow, addDays } = require('./scheduling');
const { confirmBooking } = require('../bookingRequests');
const { createPublicBookings } = require('../publicBookings');
const { customerName, identifyCustomer, saveCustomerName } = require('./customerIdentity');
const PAGE = 8;
const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
const plain = s => String(s || '').replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
const money = n => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dateLabel = d => d.split('-').reverse().join('/');
const MENU = 'Como posso te ajudar?\n\n1 - 📅 Realizar agendamento\n2 - 💰 Preços\n3 - 📍 Endereço\n4 - ❌ Cancelar agendamento';

async function transition(db, account, conversation, input, now, identity = {}) {
  require('./diagnostics').diagnostic('conversation_flow_started',{...identity,step:conversation.state.step});
  const tenant = account.id, studio = createStudio(db, () => now);
  let state = structuredClone(conversation.state);
  const command = normalize(input);
  const result = text => ({ state, text });
  const customer = await identifyCustomer(db, tenant, conversation.sender);
  const knownName = customerName(customer.nome);
  const menu = prefix => { state = { step: 'MENU' }; return result(`${prefix || ''}Olá, ${plain(knownName)}! 👋\n${plain(account.barbearia_nome)}\n${MENU}`); };
  if (!knownName) {
    if (state.step === 'ASK_NAME' && !['menu','inicio','recomecar','oi','ola','bom dia','boa tarde','boa noite','0','voltar'].includes(command)) {
      const saved = await saveCustomerName(db, tenant, conversation.sender, input);
      if (saved) { state = { step: 'MENU' }; return result(`Olá, ${plain(saved)}! 👋\n${plain(account.barbearia_nome)}\n${MENU}`); }
    }
    state = { step: 'ASK_NAME' };
    return result('Antes de começarmos, qual é o seu nome? 😊');
  }
  const catalog = async () => (await studio.services(tenant)).filter(s => s.ativo).map(({id,nome,preco,duracao,categoria})=>({id,nome,preco,duracao,categoria}));
  const people = async () => (await studio.professionals(tenant)).filter(p => p.ativo && p.servicos.includes(Number(state.service?.id)));
  async function list(step, items, label, heading, page = 0) {
    const maxPage = Math.max(0, Math.ceil(items.length / PAGE) - 1);
    page = Math.min(Math.max(0, page), maxPage);
    state.step = step; state.page = page; state.options = items.slice(page * PAGE, (page + 1) * PAGE);
    const rows = state.options.map((x, i) => `${i + 1} - ${label(x)}`).join('\n');
    return result(`${heading}\n\n${rows || 'Nenhuma opção disponível.'}${maxPage ? `\n\nPágina ${page + 1}/${maxPage} — digite MAIS ou ANTERIOR.` : ''}\n\n0 - Voltar`);
  }
  async function services(page = 0, prices = false) {
    const response = await list(prices ? 'PRICES' : 'SERVICE', await catalog(), s => `${plain(s.nome)} — ${money(s.preco)} — ${s.duracao} min`, prices ? '💰 Preços dos serviços' : '🗓 Escolha o serviço', page);
    if (prices) response.text += '\nDigite AGENDAR para escolher um serviço.';
    return response;
  }
  async function professionals(page = 0, auto = true) {
    const current = (await catalog()).find(s => s.id === state.service?.id);
    if (!current) { state = { step: 'MENU' }; return services(); }
    state.service = current;
    const options = await people();
    if (auto && options.length === 1) { state.professional = { id: options[0].id, nome: options[0].nome }; return dates(); }
    return list('PROFESSIONAL', options.map(p => ({ id: p.id, nome: p.nome })), p => plain(p.nome), '👤 Escolha o profissional', page);
  }
  async function days(page = 0) {
    // Bounded page scan. Availability is exclusively studio.times(), not another
    // scheduler. A service/worker transaction never scans the entire horizon.
    const today = localNow(now).date, items = [];
    const start = page * 7;
    for (let i = start; i < Math.min(start + 7, 91); i++) {
      const date = addDays(today, i), day = new Date(date + 'T12:00:00Z').getUTCDay();
      if (!effectiveHours(account)[day]?.length) continue;
      if ((await studio.times(tenant, date, state.service.id, state.professional.id)).length) items.push(date);
    }
    return items;
  }
  async function dates(page = 0, prefix = '') {
    page = Math.min(Math.max(0, page), 12);
    state.step = 'DATE'; state.page = page; state.options = await days(page);
    const today = localNow(now).date;
    return result(`${prefix}📅 Escolha o dia\n\n${state.options.map((d,i)=>`${i+1} - ${d === today ? 'Hoje — ' : d === addDays(today,1) ? 'Amanhã — ' : ''}${dateLabel(d)}`).join('\n') || 'Nenhum dia disponível nesta semana.'}\n\nSemana ${page+1}/13 — MAIS / ANTERIOR.\n0 - Voltar`);
  }
  async function times(page = 0, prefix = '') {
    const items = await studio.times(tenant, state.date, state.service.id, state.professional.id);
    if (!items.length) { delete state.date; delete state.time; return dates(0, prefix + 'Não há mais horários nesse dia.\n'); }
    return list('TIME', items, x => x, prefix + '🕐 Escolha o horário', page);
  }
  async function review(prefix = '') {
    const service = (await catalog()).find(s => s.id === state.service?.id);
    if (!service) { delete state.service; delete state.professional; delete state.date; delete state.time; delete state.attempt; return services(); }
    const professional = (await people()).find(p => p.id === state.professional?.id);
    if (!professional) { delete state.professional; delete state.date; delete state.time; delete state.attempt; return professionals(0, false); }
    state.service = service; state.professional = { id: professional.id, nome: professional.nome };
    if (!(await studio.times(tenant, state.date, service.id, professional.id)).includes(state.time)) { delete state.time; delete state.attempt; return times(0, 'Esse horário acabou de ficar indisponível.\n'); }
    state.step = 'REVIEW'; state.establishmentName = account.barbearia_nome; delete state.options; delete state.page;
    state.attempt = { id: crypto.randomUUID(), key: crypto.randomBytes(32).toString('hex') };
    return result(`${prefix}📋 Confira seu agendamento\n\n👤 Cliente: ${plain(state.name)}\n🏢 Estabelecimento: ${plain(account.barbearia_nome)}\n🗓 Serviço: ${plain(service.nome)}\n👤 Profissional: ${plain(professional.nome)}\n💰 Valor: ${money(service.preco)}\n⏱ Duração: ${service.duracao} min\n📅 Data: ${dateLabel(state.date)}\n🕐 Horário: ${state.time}${state.observation ? '\n📝 Observação: ' + plain(state.observation) : ''}\n\n1 - ✅ Confirmar agendamento\n2 - ✏️ Alterar escolha\n3 - 🔄 Recomeçar\n4 - ✏️ Alterar nome\n5 - 📝 Incluir observação\n6 - 👤 Agendar para outra pessoa\n0 - ↩️ Voltar`);
  }
  async function cancellations(page = 0) {
    // Only the verified sender within the currently resolved tenant. The same
    // public cancellation domain enforces status/time/notice again at commit.
    const rows = await createPublicBookings(db,()=>now).forContact(tenant, conversation.sender);
    if (!rows.length) { state = { step: 'INFO' }; return result('Não há agendamentos canceláveis para este contato. Confira a antecedência mínima e as regras do estabelecimento.\nNão envie ID, telefone ou token aqui.\n0 - Voltar'); }
    return list('CANCEL', rows, a => `${plain(a.servico_nome)} — ${dateLabel(a.data)} ${a.hora}`, 'Qual agendamento deseja cancelar?', page);
  }
  async function back() {
    delete state.attempt;
    switch (state.step) {
      case 'PROFESSIONAL': delete state.service; delete state.professional; delete state.date; delete state.time; return services();
      case 'DATE': delete state.professional; delete state.date; delete state.time; return professionals(0, false);
      case 'TIME': delete state.date; delete state.time; return dates();
      case 'NAME': case 'REVIEW': delete state.time; return times();
      case 'OBSERVATION': case 'THIRD_PARTY_NAME': return review();
      case 'EDIT': return review();
      case 'CANCEL_REVIEW': delete state.cancelId; return cancellations();
      default: return menu();
    }
  }
  if (['menu','inicio','recomecar','oi','ola','bom dia','boa tarde','boa noite','3'].includes(command) && (command !== '3' || state.step === 'REVIEW')) return menu();
  if (command === '0' || command === 'voltar') return back();
  if (command === 'mais' || command === 'anterior') {
    const page = Math.max(0, (state.page || 0) + (command === 'mais' ? 1 : -1));
    if (state.step === 'SERVICE' || state.step === 'PRICES') return services(page, state.step === 'PRICES');
    if (state.step === 'PROFESSIONAL') return professionals(page, false);
    if (state.step === 'DATE') return dates(page);
    if (state.step === 'TIME') return times(page);
    if (state.step === 'CANCEL') return cancellations(page);
  }
  const selected = /^[1-9]\d*$/.test(input) ? state.options?.[Number(input)-1] : undefined;
  switch (state.step) {
    case 'MENU':
      if (input === '1' || ['agendar','realizar agendamento','agendamento'].includes(command)) return services();
      if (input === '2' || ['precos','preco'].includes(command)) return services(0, true);
      if (input === '3' || command === 'endereco') { state = { step: 'INFO' }; const p = publicProfile(account); const address = [p.address,p.city,p.state,account.localizacao_referencia].map(plain).filter(Boolean).join(', '); return result(`📍 ${address || 'O estabelecimento ainda não cadastrou um endereço.'}\n0 - Voltar`); }
      if (input === '4' || ['cancelar','cancelar agendamento'].includes(command)) return cancellations();
      break;
    case 'SERVICE':
      if (selected) { state = { step: 'SERVICE', name: state.name || knownName, service: { id: selected.id } }; return professionals(); }
      break;
    case 'PRICES':
      if (command === 'agendar' || command === 'agendamento') return services();
      break;
    case 'PROFESSIONAL':
      if (selected && (await people()).some(p => p.id === selected.id)) { state.professional = selected; delete state.date; delete state.time; return dates(); }
      if (selected) return professionals(0, false);
      break;
    case 'DATE':
      if (selected) { state.date = selected; delete state.time; return times(); }
      break;
    case 'TIME':
      if (selected) { state.time = selected; if (state.name) return review(); state.step='NAME'; delete state.options; return result('Qual nome devo colocar no agendamento?\n0 - Voltar'); }
      break;
    case 'NAME': case 'THIRD_PARTY_NAME':
      if (customerName(input)) { state.name = customerName(input); return review(); }
      return {...result(null),invalid:true};
    case 'OBSERVATION':
      if (input.length <= 500 && !/^[0-9]+$/.test(input) && !['confirmar','sim'].includes(command) && !/[<>\r\n\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(input)) { state.observation = plain(input); return review(); }
      return {...result(null),invalid:true};
    case 'REVIEW':
      if (input === '4' || input === '6') { delete state.attempt; state.step = input === '6' ? 'THIRD_PARTY_NAME' : 'NAME'; return result('Qual nome devo colocar no agendamento?\nO cadastro do contato permanece igual.\n0 - Voltar'); }
      if (input === '5') { delete state.attempt; state.step = 'OBSERVATION'; return result('Qual observação deseja incluir? (até 500 caracteres)\n0 - Voltar'); }
      if (input === '2') { state.step = 'EDIT'; return result('Alterar qual escolha?\n1 - Serviço\n2 - Profissional\n3 - Dia\n4 - Horário\n5 - Nome\n0 - Voltar'); }
      if (input === '1' || command === 'confirmar') {
        // Lock the same rows book() will use BEFORE comparing the review.
        // Native catalog writers cannot change price/duration between comparison
        // and booking, even when they do not use the application advisory lock.
        await db.allAsync('SELECT id FROM servicos_assinatura WHERE assinatura_id=$1 AND id=$2 FOR SHARE',[tenant,state.service.id]);
        await db.allAsync('SELECT p.id FROM profissionais p JOIN profissional_servicos ps ON ps.profissional_id=p.id AND ps.assinatura_id=p.assinatura_id WHERE p.assinatura_id=$1 AND p.id=$2 AND ps.servico_id=$3 FOR SHARE OF p,ps',[tenant,state.professional.id,state.service.id]);
        const current = (await catalog()).find(s=>s.id===state.service.id), currentPerson = (await people()).find(p=>p.id===state.professional.id);
        if (!current || !currentPerson || current.nome!==state.service.nome || Number(current.preco)!==Number(state.service.preco) || current.duracao!==state.service.duracao || currentPerson.nome!==state.professional.nome || state.establishmentName!==undefined && state.establishmentName!==account.barbearia_nome) return review('As informações mudaram. Revise e confirme novamente.\n');
        if (!(await studio.times(tenant,state.date,current.id,currentPerson.id)).includes(state.time)) { delete state.time; delete state.attempt; return times(0,'Esse horário acabou de ficar indisponível. Escolha outro.\n'); }
        const body = { nome_cliente:state.name,telefone:conversation.sender,servico_id:current.id,profissional_id:currentPerson.id,data:state.date,hora:state.time };
        const attempt = state.attempt;
        await db.runAsync(`INSERT INTO whatsapp_conversation_actions(id,assinatura_id,conversation_id,owner_epoch,sender,booking_key,booking_body)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(id) DO NOTHING`, [attempt.id,tenant,conversation.id,conversation.owner_epoch,conversation.sender,attempt.key,JSON.stringify(body)]);
        // A conflict must not abort the outer inbox transaction: SAVEPOINT rolls
        // back only the booking attempt; no catalog/agenda changes are fabricated.
        await db.runAsync('SAVEPOINT conversation_booking');
        let booked;
        try { booked = await confirmBooking(db,studio,tenant,body,attempt.key,attempt.id); await db.runAsync('RELEASE SAVEPOINT conversation_booking'); }
        catch(e) { await db.runAsync('ROLLBACK TO SAVEPOINT conversation_booking'); await db.runAsync('RELEASE SAVEPOINT conversation_booking'); if(e.statusCode===409 || e.code==='23505') { delete state.time; delete state.attempt; return times(0,'Esse horário acabou de ficar indisponível. Escolha outro.\n'); } throw e; }
        const appointment = await db.getAsync('SELECT appointment_id FROM public_booking_requests WHERE assinatura_id=$1 AND key_hash=$2',[tenant,crypto.createHash('sha256').update(attempt.key).digest('hex')]);
        if (!appointment || !booked.agendamento) throw Error('Conversation booking receipt missing');
        await db.runAsync('UPDATE whatsapp_conversation_actions SET appointment_id=$1 WHERE id=$2 AND assinatura_id=$3',[appointment.appointment_id,attempt.id,tenant]);
        await db.runAsync("UPDATE agendamentos SET cliente_id=$1,origem='whatsapp',observacao=$2 WHERE id=$3 AND assinatura_id=$4",[customer.id,state.observation || null,appointment.appointment_id,tenant]);
        state = { step:'COMPLETE', appointmentId:appointment.appointment_id };
        // Exactly one producer: migration 020's durable source/materializer.
        return {state,text:null,appointmentId:appointment.appointment_id};
      }
      break;
    case 'EDIT':
      if(input==='1') { delete state.service;delete state.professional;delete state.date;delete state.time;delete state.attempt;return services(); }
      if(input==='2') { delete state.professional;delete state.date;delete state.time;delete state.attempt;return professionals(0,false); }
      if(input==='3') { delete state.date;delete state.time;delete state.attempt;return dates(); }
      if(input==='4') { delete state.time;delete state.attempt;return times(); }
      if(input==='5') { delete state.attempt;state.step='NAME';return result('Qual nome devo colocar no agendamento?\n0 - Voltar'); }
      break;
    case 'CANCEL':
      if(selected) { state.cancelId=selected.id;state.step='CANCEL_REVIEW';delete state.options;return result(`Cancelar ${plain(selected.servico_nome)} em ${dateLabel(selected.data)} às ${selected.hora}?\n1 - Confirmar cancelamento\n0 - Voltar`); }
      break;
    case 'CANCEL_REVIEW':
      if(input==='1' || command==='confirmar') {
        try { await createPublicBookings(db,()=>now).cancelForContact(tenant,conversation.sender,state.cancelId); return menu('Agendamento cancelado com segurança.\n'); }
        catch(e) { if(e.statusCode===409 || e.statusCode===404) return menu(`${plain(e.message)}\n`);throw e; }
      }
      break;
    case 'COMPLETE': return menu('Seu agendamento já foi registrado. A confirmação é enviada pela fila segura.\n');
  }
  return {...result(null),invalid:true};
}
module.exports = { transition, normalize, MENU };
