const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}),token=localStorage.getItem('barbearia_auth_token');
const sections=['Dashboard','Agendamentos','WhatsApp','Conversas','Clientes','Meus serviços','Profissionais','Financeiro','Horários','Minha página','Notificações','Relatórios','Configurações','Assinatura'];
let account;
let refreshInFlight=null;
let state,section='Dashboard',agendaDate=todayLocal(),agendaMode='week',agendaFilter='todos',agendaProfessional='';
function todayLocal(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());}
const iconPaths=['M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z','M4 5h16v16H4z M8 3v4 M16 3v4 M4 11h16','M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4','M4 5h16v15H4z M8 5V3h8v2 M4 11h16','M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21v-2a6 6 0 0 1 6-5h4a6 6 0 0 1 6 5v2','M3 5h18v15H3z M3 9h18 M15 14h3','M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v5l3 2','M3 3h18v18H3z M3 8h18 M8 8v13','M5 17h14l-2-4V9a5 5 0 0 0-10 0v4z M10 21h4','M4 20V10 M10 20V4 M16 20v-8 M22 20H2','M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2','M3 6h18v14H3z M3 10h18'];
const icon=i=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[i]}"/></svg>`;
async function requestJson(url,options){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
 try{
  const r=await fetch(url,{...options,signal:controller.signal,cache:'no-store'});
  const data=await r.json();
  if(r.status===401)location.href='/login.html';
  if(!r.ok){const error=Error(data.error || 'Não foi possível concluir.');error.status=r.status;error.details=data;throw error;}
  return data;
 }catch(error){if(error.name==='AbortError')throw Error('O servidor demorou para responder. Tente novamente.');throw error;}
 finally{clearTimeout(timeout);}
}
async function api(path='',method='GET',body){
 try{return await requestJson('/api/studiofy'+path,{method,headers:{'Content-Type':'application/json','x-barbeiro-token':token || ''},body:body?JSON.stringify(body):undefined});}
 catch(error){if(error.status===403 && error.details?.acesso && !refreshInFlight)await refresh();throw error;}
}
function message(value,error=false){$('#message').textContent=value;$('#message').classList.toggle('error',error);}
async function action(fn){try{await fn();}catch(e){message(e.message,true);}}
async function accountApi(path, method='GET') {
 return requestJson('/api'+path,{method,headers:{'Content-Type':'application/json','x-barbeiro-token':token || ''}});
}
async function subscriptionView(){
 const config=await accountApi('/publico/assinatura-config');
 const price=Number(account.valor_plano)>0?Number(account.valor_plano):config.plan.amountCents/100;
 $('#view').innerHTML=`<div class="card"><h2>Assinar Studiofy</h2><p>${esc(account.acesso?.mensagem || '')}</p><p>${money(price)} por ${config.plan.durationDays} dias</p><button id="subscribe" class="primary">Assinar Studiofy</button><button id="checkAccess">Verificar pagamento</button></div>`;
 $('#subscribe').onclick=()=>action(async()=>{const payment=await accountApi('/publico/assinaturas/'+account.id+'/checkout','POST');location.assign(payment.checkoutUrl);});
 $('#checkAccess').onclick=()=>action(refresh);
}
function dashboardStatus(status){
 let box=$('#dashboardStatus');if(!box){box=document.createElement('div');box.id='dashboardStatus';box.className='dashboard-status';box.setAttribute('aria-live','polite');$('#view').before(box);}
 box.dataset.state=status;$('#view').setAttribute('aria-busy',String(status==='loading'));
 if(status==='loading')box.textContent=state?'Atualizando dados…':'Carregando painel…';
 else if(status==='error'){
  box.innerHTML='<span>'+(state?'Falha na atualização. Os dados exibidos podem estar desatualizados.':'Não foi possível carregar o painel.')+'</span> <button id="retryDashboard" type="button">Tentar novamente</button>';
  $('#retryDashboard').onclick=()=>action(refresh);
 }else box.textContent='Atualizado em '+new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'});
}
function refresh(){
 if(refreshInFlight)return refreshInFlight;
 message('');
 dashboardStatus('loading');
 if(!state)$('#view').innerHTML='<div class="card" role="status">Carregando os dados do estabelecimento…</div>';
 refreshInFlight=loadPanel().then(()=>dashboardStatus('ready')).catch(async error=>{
  dashboardStatus('error');
  if(error.status===403 && error.details?.acesso){
   account={...account,id:account?.id || error.details.id,acesso:error.details.acesso};state=null;await showAccessRequired();
  }else if(!state)$('#view').innerHTML='<div class="card">Os indicadores estarão disponíveis quando o carregamento for concluído.</div>';
  throw error;
 }).finally(()=>{refreshInFlight=null;});
 return refreshInFlight;
}
async function showAccessRequired(){
 window.StudiofyWhatsapp?.unmount();window.StudiofyInbox?.pause();
 state=null;$('#title').textContent='Assinatura';$('#navigation').innerHTML='<button id="plans">Ver planos</button>';
 $('#plans').onclick=()=>action(subscriptionView);await subscriptionView();
}
async function loadPanel(){
 const nextAccount=await accountApi('/barbeiro/me');
 account=nextAccount;
 $('#salonName').textContent=account.barbearia_nome;$('#sidebarSalon').textContent=account.barbearia_nome;
 const access=account.acesso;
 let banner=$('#trialBanner');if(!banner){banner=document.createElement('div');banner.id='trialBanner';banner.className='card dashboard-access';$('#view').before(banner);}
 banner.hidden=access?.status==='subscription_active';
 banner.textContent=access?.status==='trial_active'?`7 dias grátis: termina em ${new Date(access.trial.endsAt).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})} (${access.trial.daysRemaining} dia(s) restantes).`:access?.mensagem || '';
 if(access && !access.liberado){
  await showAccessRequired();return;
 }
 state=await api('/painel');window.StudiofyInbox?.resume();$('#publicLink').href='/agendar/'+state.pagina.slug;render();
}
const table=(headers,rows)=>`<div class="card table-wrap"><table><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(r=>'<tr>'+r.map(c=>`<td>${c}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${headers.length}" class="empty">Nenhum registro por aqui ainda.</td></tr>`}</tbody></table></div>`;
const field=(label,name,type='text',value='',extra='')=>`<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
function normalizeClientPhone(value){
 let digits=String(value || '').replace(/\D/g,'');
 if(digits.length===12 || digits.length===13){if(digits.startsWith('55'))digits=digits.slice(2);}
 return /^\d{10,11}$/.test(digits)?digits:'';
}
function servedClients(){
 const clients=new Map();
 const phones=new Map(state.agendamentos.map(a=>[a.id,a.telefone]));
 for(const a of state.financeiro?.historico || []){
  const phone=normalizeClientPhone(phones.get(a.id));
  if(!phone)continue;
  const client=clients.get(phone)||{nome:a.cliente,telefone:phone,visitas:0};client.visitas++;clients.set(phone,client);
 }
 return clients;
}
function renderDashboard(view){
 const f=state.financeiro,appointments=state.agendamentos;
 const date=state.agenda?.hoje || f?.referencia || today();
 const dateLabel=date.split('-').reverse().join('/');
 const day=appointments.filter(a=>a.data===date);
 const scheduled=day.filter(a=>a.status==='confirmado').length;
 const completed=f?.hoje.atendimentos;
 const operational=completed===undefined?'—':scheduled+completed;
 const time=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
 const upcoming=appointments.filter(a=>a.status==='confirmado' &&
  (typeof a.futuro==='boolean'?a.futuro:a.data+'T'+a.hora>date+'T'+time))
  .sort((a,b)=>(a.data+a.hora).localeCompare(b.data+b.hora)||a.id-b.id).slice(0,5);
 const activeProfessionals=state.profissionais.filter(p=>p.ativo===true).length;
 const access=account?.acesso;
 const accessLabel=access?.status==='trial_active'?'Teste grátis ativo':
  access?.status==='subscription_active'?'Assinatura ativa':access?.mensagem || 'Situação indisponível';
 const currency=period=>f?money(f[period].valor_centavos/100):'—';
 const metrics=[
  ['today','Agendamentos de hoje',operational,'Agendados e concluídos · '+dateLabel,1],
  ['clients','Clientes atendidos',f?servedClients().size:'—','Telefones únicos · todo o histórico',2],
  ['revenue-today','Faturamento de hoje',currency('hoje'),'Somente concluídos · '+dateLabel,5],
  ['revenue-month','Faturamento do mês',currency('mes'),'Mês atual · somente concluídos',5],
 ];
 view.innerHTML='<div class="section-intro"><p>Hoje · '+esc(dateLabel)+' <span class="muted">· horário de São Paulo</span></p><button id="newBooking" class="primary">+ Novo agendamento</button></div>'+
  '<div class="metrics dashboard-metrics">'+metrics.map(([key,label,value,note,i])=>
   `<article class="card metric" data-dashboard="${key}"><div class="metric-label">${icon(i)}${label}</div><strong class="stat">${value}</strong><small class="metric-note">${note}</small></article>`).join('')+'</div>'+
  '<section class="card dashboard-finance" aria-labelledby="dashboardFinanceTitle"><div class="panel-heading"><h2 id="dashboardFinanceTitle">Resumo financeiro</h2><button id="seeFinance" class="text-button">Ver financeiro ↗</button></div>'+
  '<p class="muted">Preço registrado no atendimento. Somente concluídos, sem atendimentos futuros.</p>'+
  (f?'<dl class="financial-strip">'+[['hoje','Hoje',dateLabel],['semana','Esta semana','Desde '+f.inicio_semana.split('-').reverse().join('/')+' · segunda-feira'],['mes','Este mês','Desde '+f.inicio_mes.split('-').reverse().join('/')]].map(([key,label,note])=>
   `<div data-dashboard-period="${key}"><dt>${label}</dt><dd>${currency(key)}</dd><small>${esc(note)} · ${f[key].atendimentos} atendimento(s)</small></div>`).join('')+'</dl>'+
   (f.total.atendimentos?'':'<p class="muted">Nenhum atendimento concluído ainda.</p>'):'<p role="alert">Resumo financeiro indisponível. Tente atualizar o painel.</p>')+'</section>'+
  '<div class="dashboard-columns dashboard-content"><section class="card upcoming" aria-labelledby="upcomingTitle"><div class="panel-heading"><h2 id="upcomingTitle">Próximos agendamentos</h2><button id="seeAgenda" class="text-button">Ver agenda ↗</button></div><p class="muted">Até cinco atendimentos agendados após o horário atual.</p>'+
  (upcoming.length?upcoming.map(a=>'<div class="appointment-summary"><span class="avatar">'+esc((a.nome_cliente || '').slice(0,1))+'</span><div class="appointment-person"><strong>'+esc(a.nome_cliente)+'</strong><small>'+esc(a.servico_nome)+(a.profissional?' · '+esc(a.profissional):'')+'</small></div><div class="appointment-time"><strong>'+esc(a.hora)+'</strong><small>'+esc(a.data.split('-').reverse().join('/'))+'</small></div></div>').join(''):
   '<div class="empty-state">'+icon(1)+'<h3>Nenhum próximo agendamento</h3><p>Os próximos horários confirmados aparecerão aqui.</p></div>')+'</section>'+
  '<section class="card" aria-labelledby="todayStatusTitle"><div class="panel-heading"><h2 id="todayStatusTitle">Situação dos agendamentos</h2><span class="pill">Hoje · '+esc(dateLabel)+'</span></div><dl class="appointment-status-summary">'+
  [['confirmado','Agendados',scheduled],['concluido','Concluídos',completed??'—'],['cancelado','Cancelados',day.filter(a=>a.status==='cancelado').length],['falta','Faltas',day.filter(a=>a.status==='falta').length]].map(([key,label,count])=>
   `<div data-dashboard-status="${key}"><dt><span class="status-dot dot-${key}" aria-hidden="true"></span>${label}</dt><dd>${count}</dd></div>`).join('')+'</dl><p class="muted">Agendamentos de hoje inclui agendados e concluídos. Cancelamentos e faltas ficam separados.</p></section></div>'+
  '<div class="dashboard-columns dashboard-bottom"><section class="card" aria-labelledby="topServicesTitle"><div class="panel-heading"><h2 id="topServicesTitle">Serviços mais realizados</h2><span class="pill">Todo o histórico</span></div>'+
  (f?.servicos.length?'<ol class="dashboard-ranking">'+f.servicos.slice(0,3).map(s=>'<li><strong>'+esc(s.servico)+'</strong><span>'+s.atendimentos+' atendimento(s)</span></li>').join('')+'</ol>':
   '<p class="muted">'+(f?'Nenhum atendimento concluído ainda.':'Ranking indisponível.')+'</p>')+'</section>'+
  '<section class="card dashboard-establishment" aria-labelledby="establishmentSummaryTitle"><h2 id="establishmentSummaryTitle">Seu estabelecimento</h2><dl><div data-dashboard-professionals><dt>Profissionais ativos</dt><dd>'+activeProfessionals+' <small>de '+state.profissionais.length+' cadastrado(s)</small></dd></div>'+
  '<div data-dashboard-subscription><dt>Situação da assinatura</dt><dd>'+esc(accessLabel)+'</dd></div></dl><button id="seeSubscription" class="text-button">Ver assinatura ↗</button></section></div>';
 $('#newBooking').onclick=()=>bookingForm();
 $('#seeAgenda').onclick=()=>{section='Agendamentos';render();};
 $('#seeFinance').onclick=()=>{section='Financeiro';render();};
 $('#seeSubscription').onclick=()=>{section='Assinatura';render();};
}
function render(){
 window.StudiofyWhatsapp?.unmount();
 window.StudiofyInbox?.unmount();
 $('#title').textContent=section==='WhatsApp'?'Conectar WhatsApp':section;$('#navigation').innerHTML=sections.map((s,i)=>`<button ${s===section?'class="active"':''} data-section="${s}">${s==='Conversas'?'<span aria-hidden="true">💬</span>':s==='WhatsApp'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 11a9 9 0 0 1-9 9H4l-3 2 2-6a9 9 0 1 1 18-5Z"/><path d="M7 8h10M7 12h7"/></svg>':icon(i>3?i-2:i)}<span>${s}</span>${s==='Conversas'?'<span id="inboxBadge" hidden></span><small id="inboxBadgeConnection" hidden role="status">Tentando atualizar…</small>':''}</button>`).join('');
 window.StudiofyInbox?.paintBadge();
 document.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>{section=b.dataset.section;message('');render();});
 if(section==='Assinatura'){action(subscriptionView);return;}
 if(section==='WhatsApp'){window.StudiofyWhatsapp.mount($('#view'),token,account.id,()=>action(refresh));return;}
 if(section==='Conversas'){window.StudiofyInbox.mount($('#view'),token,()=>action(refresh));return;}
 const view=$('#view'),appointments=state.agendamentos;
 if(section==='Dashboard'){
  renderDashboard(view);
 }else if(section==='Agendamentos'){
  renderAgenda(view,appointments);
 }else if(section==='Clientes'){
  const clients=servedClients();
  view.innerHTML='<p class="muted">Clientes com atendimentos concluídos, agrupados pelo telefone normalizado. Cancelamentos, faltas e reservas futuras não entram na contagem.</p>'+table(['Nome','WhatsApp','Atendimentos concluídos'],[...clients.values()].map(c=>[esc(c.nome),esc(c.telefone),c.visitas]));
 }else if(section==='Meus serviços'){
  view.innerHTML='<div class="row"><p class="muted">Cuidados que levam a sua assinatura.</p><button id="addService" class="primary">+ Adicionar serviço</button></div><div class="service-list">'+state.servicos.map(s=>`<article class="card service-row">${s.foto?`<img class="service-photo" src="${esc(s.foto)}" alt="">`:`<div class="service-placeholder">${icon(3)}</div>`}<span class="pill">${s.ativo?'Ativo':'Inativo'}</span><h3 style="margin-top:15px">${esc(s.nome)}</h3><p class="muted">${esc(s.categoria || '')}</p><p class="muted">${esc(s.descricao)}</p><p>${money(s.preco)} · ${s.duracao} min</p><button data-edit-service="${s.id}">Editar</button> <button data-delete-service="${s.id}">Excluir / desativar</button></article>`).join('')+'</div>';
  $('#addService').onclick=()=>serviceForm();document.querySelectorAll('[data-edit-service]').forEach(b=>b.onclick=()=>serviceForm(state.servicos.find(s=>s.id===+b.dataset.editService)));document.querySelectorAll('[data-delete-service]').forEach(b=>b.onclick=()=>action(async()=>{await api('/servicos/'+b.dataset.deleteService,'DELETE');await refresh();message('Serviço desativado. Histórico preservado.');}));
 }else if(section==='Profissionais'){
  view.innerHTML='<button id="addProfessional" class="primary">+ Adicionar profissional</button>'+table(['Nome','Serviços','Status',''],state.profissionais.map(p=>[esc(p.nome),p.servicos.map(id=>esc(state.servicos.find(s=>s.id===id)?.nome)).join(', '),p.ativo?'Ativo':'Inativo',`<button data-professional="${p.id}">Editar</button>`]));$('#addProfessional').onclick=()=>professionalForm();document.querySelectorAll('[data-professional]').forEach(b=>b.onclick=()=>professionalForm(state.profissionais.find(p=>p.id===+b.dataset.professional)));
 }else if(section==='Minha página')pageForm();
 else if(section==='Horários')hoursForm();
 else if(section==='Notificações')view.innerHTML='<p class="muted">Lembretes previstos para 20 minutos antes. Entregas incertas exigem conferência no WhatsApp. Mensagens vencidas não são enviadas.</p>'+table(['Cliente','Atendimento','Lembrete previsto','Status','Tentativas','Último erro'],state.lembretes.map(r=>[esc(r.nome_cliente),esc(r.data+' '+r.hora),new Date(r.due_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),esc(({pending:'Pendente',sending:'Enviando',sent:'Enviado',cancelled:'Cancelado',uncertain:'Entrega incerta',expired:'Expirado'})[r.status]),r.attempts,esc(r.last_error || '—')]));
 else if(section==='Financeiro' || section==='Relatórios'){
  renderFinance(view,section==='Relatórios');
 }else view.innerHTML=`<div class="card"><h2>${section==='Assinatura'?'Minha assinatura':'Conexões e configurações'}</h2><p class="muted">${section==='Assinatura'?'Consulte sua assinatura e os pagamentos no painel integrado.':'Gerencie a conexão do WhatsApp e o suporte no painel integrado. Agendamentos são feitos pela sua página pública.'}</p><a class="button primary" href="/barbeiro.html">${section==='Assinatura'?'Gerenciar assinatura':'Configurar WhatsApp e suporte'}</a></div>`;
 if(section==='Configurações'){
  view.insertAdjacentHTML('afterbegin',`<div class="card"><h2>Cancelamento pelo cliente</h2><p class="muted">Defina a antecedência mínima em minutos. Com zero, o cliente pode cancelar até antes do início do atendimento. A regra vale também para reservas já existentes.</p><form id="cancellationPolicy" class="stack">${field('Antecedência mínima (minutos)','antecedencia_minutos','number',state.pagina.antecedencia_cancelamento_minutos??0,'required min="0" max="129600" step="1"')}<button class="primary" type="submit">Salvar regra de cancelamento</button></form></div>`);
  $('#cancellationPolicy').onsubmit=e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button');b.disabled=true;action(async()=>{try{await api('/politica-cancelamento','PUT',{antecedencia_minutos:Number(f.antecedencia_minutos.value)});await refresh();message('Regra de cancelamento salva.');}finally{b.disabled=false;}});};
 }
}
function renderFinance(view,reports=false){
 const f=state.financeiro,formatDate=d=>d.split('-').reverse().join('/');
 if(!f){
  view.innerHTML='<div class="finance-view card" role="alert"><p>Financeiro indisponível. Tente atualizar os dados.</p><button id="refreshFinance" type="button">Tentar novamente</button></div>';
  $('#refreshFinance').onclick=()=>action(refresh);return;
 }
 const financeTable=(headers,rows,empty,label)=>rows.length
  ? `<p class="finance-table-note">Deslize a tabela para ver todas as colunas.</p><div class="card table-wrap" role="region" aria-label="${esc(label)}" tabindex="0"><table><thead><tr>${headers.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>'<tr>'+row.map((cell,i)=>`<td${headers[i].startsWith('Valor')?' class="finance-amount"':''}>${cell}</td>`).join('')+'</tr>').join('')}</tbody></table></div>`
  : `<p class="card finance-empty" role="status">${empty}</p>`;
 const services=financeTable(['Serviço','Atendimentos concluídos','Valor faturado'],
  f.servicos.map(s=>[esc(s.servico),s.atendimentos,money(s.valor_centavos/100)]),
  'Nenhum serviço realizado com atendimento concluído válido.','Serviços realizados e faturamento');
 const intro='<div class="section-intro finance-intro"><p>Receita dos atendimentos concluídos · horário de São Paulo</p><button id="refreshFinance" type="button">Atualizar dados</button></div>';
 const serviceSection='<section id="financeServices" aria-labelledby="financeServicesTitle"><h2 id="financeServicesTitle">Serviços mais realizados · todo o histórico</h2><p class="muted finance-caption">Ordenados por quantidade realizada, depois pelo faturamento.</p>'+services+'</section>';
 if(reports){view.innerHTML='<div class="finance-view">'+intro+serviceSection+'</div>';}
 else{
  const periods=[['hoje','Faturamento de hoje',formatDate(f.referencia)],
   ['semana','Faturamento da semana',`Desde ${formatDate(f.inicio_semana)} · segunda-feira`],
   ['mes','Faturamento do mês',`Desde ${formatDate(f.inicio_mes)}`]];
  view.innerHTML='<div class="finance-view">'+intro+'<div class="metrics finance-metrics">'+periods.map(([key,label,note])=>
   `<article class="card metric" data-finance="${key}" aria-label="${label}"><h2 class="metric-label">${label}</h2><strong class="stat">${money(f[key].valor_centavos/100)}</strong><p class="finance-count">${f[key].atendimentos} atendimento(s) concluído(s)</p><small class="metric-note">${note}</small>${f[key].atendimentos?'':'<p class="finance-period-empty">Nenhum atendimento concluído neste período.</p>'}</article>`).join('')+'</div>'+
   `<div class="card finance-total" data-finance="total"><div><h2>Atendimentos concluídos</h2><small>Todo o histórico financeiro válido</small></div><strong class="stat">${f.total.atendimentos}</strong><span>${money(f.total.valor_centavos/100)} faturados</span></div>`+
   serviceSection+
   '<section id="financeMonths" aria-labelledby="financeMonthsTitle"><h2 id="financeMonthsTitle">Faturamento por mês</h2>'+financeTable(['Mês','Atendimentos concluídos','Valor faturado'],f.meses.map(m=>[esc(m.mes.split('-').reverse().join('/')),m.atendimentos,money(m.valor_centavos/100)]),'Nenhum faturamento mensal registrado.','Faturamento por mês')+'</section>'+
   '<section id="financeHistory" aria-labelledby="financeHistoryTitle"><h2 id="financeHistoryTitle">Histórico financeiro</h2><p class="muted finance-caption">Preço salvo no atendimento. Do mais recente ao mais antigo.</p>'+financeTable(['Data / horário','Cliente','Serviço / profissional','Valor do atendimento','Status'],f.historico.map(a=>[esc(formatDate(a.data)+' · '+a.hora),esc(a.cliente || 'Cliente não informado'),esc(a.servico)+'<br><small>'+esc(a.profissional || 'Profissional não informado')+'</small>',money(a.valor_centavos/100),'<span class="pill">Concluído</span>']),'Nenhum registro financeiro: nenhum atendimento concluído válido.','Histórico de atendimentos faturados')+'</section>'+
   '<p class="muted finance-caption">Somente concluídos com data, horário e preço histórico válidos, cujo horário já foi alcançado. Não representa conciliação bancária.</p></div>';
 }
 $('#refreshFinance').onclick=()=>action(refresh);
}
const statusLabel=s=>({confirmado:'Agendado',concluido:'Concluído',cancelado:'Cancelado',falta:'Falta',pendente:'Pendente'})[s] || s;
const statusBadge=a=>`<span class="agenda-status status-${esc(a.status)}">${esc(statusLabel(a.status))}</span>`;
let agendaMutationInFlight=false,agendaSlotsInFlight=null;
async function agendaSlotsQuery(key,isCurrent){
 // A form reopened while a previous request finishes must not start a parallel query.
 while(agendaSlotsInFlight){try{await agendaSlotsInFlight;}catch{}if(!isCurrent())return null;}
 if(!isCurrent())return null;
 const request=api('/horarios?'+key);agendaSlotsInFlight=request;
 try{return await request;}finally{if(agendaSlotsInFlight===request)agendaSlotsInFlight=null;}
}
function lockAgendaActions(disabled){document.querySelectorAll('[data-status],[data-reschedule],[data-detail-reschedule],#newBooking').forEach(el=>el.disabled=disabled);}
function agendaTiming(a){
 const valid=typeof a.data==='string' && /^\d{4}-\d{2}-\d{2}$/.test(a.data) && !isNaN(Date.parse(a.data)) && new Date(a.data).toISOString().slice(0,10)===a.data && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.hora || '');
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
 const current=`${parts.year}-${parts.month}-${parts.day}${parts.hour}:${parts.minute}`;
 return {valid,future:valid && a.data+a.hora>current};
}
const agendaCanReschedule=a=>a.status==='confirmado' && a.futuro===true && agendaTiming(a).future;
const agendaCanFinish=a=>a.status==='confirmado' && a.pode_concluir===true && agendaTiming(a).valid && !agendaTiming(a).future;
function agendaEmpty(){
 if(agendaProfessional)return 'Nenhum agendamento para este profissional no filtro selecionado.';
 return {hoje:'Nenhum agendamento hoje.',proximos:'Nenhum próximo agendamento.',concluidos:'Nenhum atendimento concluído.',cancelados:'Nenhum agendamento cancelado.'}[agendaFilter] || 'Nenhum agendamento cadastrado.';
}
function appointmentTable(rows){return '<div class="agenda-list">'+(rows.length?rows.map(a=>`<article class="card agenda-item" data-agenda-booking="${a.id}"><div><small>Data / horário</small><strong>${esc(a.data.split('-').reverse().join('/'))} · ${esc(a.hora)}</strong></div><div><small>Cliente</small><strong>${esc(a.nome_cliente)}</strong></div><div><small>Serviço</small><span>${esc(a.servico_nome)}</span></div><div><small>Profissional</small><strong>${esc(a.profissional || 'Profissional principal')}</strong></div><div><small>Valor</small><span>${money(a.preco || 0)}</span></div><div><small>Status</small>${statusBadge(a)}</div><div class="agenda-actions"><button data-view-booking="${a.id}">Ver detalhes</button>${agendaCanReschedule(a)?`<button data-reschedule="${a.id}" ${agendaMutationInFlight?'disabled':''}>Remarcar</button>`:''}${a.status==='confirmado'?`<select aria-label="Alterar status de ${esc(a.nome_cliente)}" data-status="${a.id}" ${agendaMutationInFlight?'disabled':''}><option value="">Ações</option><option value="cancelado">Cancelar</option>${agendaCanFinish(a)?'<option value="concluido">Concluir</option><option value="falta">Registrar falta</option>':''}</select>`:''}${a.status==='confirmado'&&!agendaCanFinish(a)?'<small>Conclusão e falta disponíveis a partir do horário agendado, após atualizar a Agenda.</small>':''}</div></article>`).join(''):`<p class="card empty" role="status">${agendaEmpty()}</p>`)+'</div>';}
function showBookingDetails(a){
 const dialog=document.createElement('dialog');dialog.className='agenda-dialog';dialog.setAttribute('aria-labelledby','bookingDetailsTitle');dialog.setAttribute('tabindex','-1');
 dialog.innerHTML=`<h2 id="bookingDetailsTitle">Dados do agendamento</h2>${statusBadge(a)}<dl><dt>Cliente</dt><dd>${esc(a.nome_cliente)}</dd><dt>Telefone</dt><dd>${esc(a.telefone || 'Não informado')}</dd><dt>Serviço</dt><dd>${esc(a.servico_nome)}</dd><dt>Profissional</dt><dd>${esc(a.profissional || 'Profissional principal')}</dd><dt>Data e horário</dt><dd>${esc(a.data.split('-').reverse().join('/'))} · ${esc(a.hora)}</dd><dt>Duração</dt><dd>${esc(a.duracao)} minutos</dd><dt>Valor do atendimento</dt><dd>${money(a.preco || 0)}</dd></dl>${agendaCanReschedule(a)?`<button type="button" data-detail-reschedule ${agendaMutationInFlight?'disabled':''}>Remarcar</button> `:''}<button type="button" data-close-details>Fechar</button>`;
 dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('[data-close-details]').onclick=()=>dialog.close();const reschedule=dialog.querySelector('[data-detail-reschedule]');if(reschedule)reschedule.onclick=()=>{dialog.close();bookingForm(a);};document.body.append(dialog);dialog.showModal();dialog.focus();dialog.scrollTop=0;
}
function bindAppointments(){
 document.querySelectorAll('[data-view-booking]').forEach(b=>b.onclick=()=>showBookingDetails(state.agendamentos.find(a=>a.id===+b.dataset.viewBooking)));
 document.querySelectorAll('[data-reschedule]').forEach(b=>b.onclick=()=>bookingForm(state.agendamentos.find(a=>a.id===+b.dataset.reschedule)));
 document.querySelectorAll('[data-status]').forEach(b=>b.onchange=()=>{
  const status=b.value,a=state.agendamentos.find(a=>a.id===+b.dataset.status);b.value='';
  if(!status || agendaMutationInFlight || !a || a.status!=='confirmado')return;
  if(!['cancelado','concluido','falta'].includes(status) || (status!=='cancelado'&&!agendaCanFinish(a)))return;
  const verb={cancelado:'cancelar',concluido:'concluir',falta:'registrar falta para'}[status];
  if(!confirm(`Deseja ${verb} o atendimento de ${a.nome_cliente}? Este estado será final e não permitirá remarcação.`))return;
  agendaMutationInFlight=true;lockAgendaActions(true);message('Atualizando agendamento…');
  action(async()=>{let saved=false;try{await api('/agendamentos/'+a.id,'PATCH',{status});saved=true;await refresh();message({cancelado:'Agendamento cancelado.',concluido:'Atendimento concluído.',falta:'Falta registrada.'}[status]);}
   catch(error){message(saved?'A alteração foi salva, mas não foi possível atualizar a Agenda. Tente atualizar novamente.':error.message,true);}
   finally{agendaMutationInFlight=false;lockAgendaActions(false);}});
 });
}
function form(title,html,save){message('');$('#view').innerHTML=`<div class="card"><h2>${title}</h2><form id="editor" class="stack">${html}<div class="row"><button type="button" id="cancel">Voltar</button><button class="primary" type="submit">Salvar alterações</button></div></form></div>`;$('#cancel').onclick=render;$('#editor').onsubmit=e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('[type=submit]');b.disabled=true;message('Salvando alterações…');action(async()=>{try{await save(f);await refresh();message('Alterações salvas.');}finally{b.disabled=false;}});};}
const readFile=file=>new Promise((resolve,reject)=>{if(!file)return resolve(null);if(file.size>2*1024*1024 || !['image/png','image/jpeg','image/webp'].includes(file.type))return reject(Error('Use PNG, JPEG ou WebP de até 2 MB.'));const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('Falha ao ler imagem.'));r.readAsDataURL(file);});
function serviceForm(s={}){form(s.id?'Editar serviço':'Adicionar serviço',`<div class="form-grid">${field('Nome','nome','text',s.nome,'required maxlength="100"')}${field('Categoria','categoria','text',s.categoria,'maxlength="100"')}${field('Preço (R$)','preco','number',s.preco ?? '', 'required min="0" max="100000" step="0.01"')}${field('Duração (minutos)','duracao','number',s.duracao || 30,'required min="5" max="720"')}${field('Foto (PNG, JPEG ou WebP, até 2 MB)','foto','file','','accept="image/png,image/jpeg,image/webp"')}<label class="wide">Descrição<textarea name="descricao" maxlength="1000">${esc(s.descricao)}</textarea></label><label><span><input name="ativo" type="checkbox" ${s.ativo!==false?'checked':''}> Ativo</span></label><label><span><input name="removePhoto" type="checkbox"> Remover foto</span></label></div>`,async f=>{const data=Object.fromEntries(new FormData(f));await api('/servicos'+(s.id?'/'+s.id:''),s.id?'PUT':'POST',{...data,preco:+data.preco,duracao:+data.duracao,ativo:f.ativo.checked,foto:f.removePhoto.checked?null:await readFile(f.foto.files[0]) || s.foto || null});});}
function professionalForm(p={}){form(p.id?'Editar profissional':'Adicionar profissional',`${field('Nome','nome','text',p.nome,'required maxlength="100"')}<label><span><input name="ativo" type="checkbox" ${p.ativo!==false?'checked':''}> Ativo</span></label><p>Serviços realizados</p>${state.servicos.map(s=>`<label><span><input name="services" type="checkbox" value="${s.id}" ${p.servicos?.includes(s.id)?'checked':''}> ${esc(s.nome)}</span></label>`).join('')}`,async f=>api('/profissionais'+(p.id?'/'+p.id:''),p.id?'PUT':'POST',{nome:f.nome.value,ativo:f.ativo.checked,servicos:[...f.querySelectorAll('[name=services]:checked')].map(x=>+x.value)}));}
function bookingForm(a={}){
 if(agendaMutationInFlight)return;
 if(a.id&&!agendaCanReschedule(a)){message('Este atendimento não permite remarcação. Atualize a Agenda.',true);return;}
 const services=state.servicos.filter(s=>s.ativo);
 form(a.id?'Remarcar agendamento':'Novo agendamento',`<div class="form-grid">${field('Cliente','nome_cliente','text',a.nome_cliente,'required minlength="2" maxlength="100"')}${field('WhatsApp','telefone','tel',a.telefone,'required')}<label>Serviço<select name="servico_id" required>${services.map(s=>`<option value="${s.id}" ${s.id===a.studio_service_id?'selected':''}>${esc(s.nome)}</option>`).join('')}</select></label><label>Profissional<select name="profissional_id" required></select></label>${field('Data','data','date',a.data || today(),'required')}<label>Horário<select name="hora" required><option value="">Escolha a data</option></select></label></div>`,async f=>api('/agendamentos'+(a.id?'/'+a.id:''),a.id?'PUT':'POST',Object.fromEntries(new FormData(f))));
 const f=$('#editor');f.closest('.card').classList.add('agenda-booking-form');
 f.hora.parentElement.insertAdjacentHTML('beforeend','<small id="agendaSlotsStatus" role="status" aria-live="polite"></small><button id="retryAgendaSlots" type="button" hidden>Tentar novamente</button>');
 const notice=$('#agendaSlotsStatus'),retry=$('#retryAgendaSlots'),save=f.querySelector('[type=submit]');
 let version=0,inFlight=false,queued=false,pendingKey='',slotsReady=false,saving=false;
 const updateSave=()=>{save.disabled=saving || inFlight || !slotsReady || !f.hora.value;};
 const slots=async()=>{
  if(!f.isConnected || saving)return;
  const key=new URLSearchParams({data:f.data.value,servico_id:f.servico_id.value,profissional_id:f.profissional_id.value,excluir_id:a.id || 0}).toString();
  if(inFlight&&key===pendingKey)return;
  pendingKey=key;const current=++version;slotsReady=false;f.hora.disabled=true;retry.hidden=true;
  f.hora.innerHTML='<option value="">Consultando…</option>';notice.textContent='Consultando horários disponíveis…';notice.classList.remove('error');updateSave();
  if(inFlight){queued=true;return;}
  if(!f.data.value || !f.servico_id.value || !f.profissional_id.value){
   f.hora.innerHTML='<option value="">Selecione serviço, profissional e data</option>';notice.textContent='Escolha um serviço ativo, um profissional disponível e a data.';return;
  }
  inFlight=true;f.hora.setAttribute('aria-busy','true');updateSave();
  try{
   const times=await agendaSlotsQuery(key,()=>current===version&&f.isConnected);
   if(current!==version || !f.isConnected)return;
   if(!Array.isArray(times) || times.some(t=>typeof t!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))throw Error('Não foi possível consultar os horários. Tente novamente.');
   f.hora.innerHTML='<option value="">'+(times.length?'Escolha um horário':'Nenhum horário disponível')+'</option>'+times.map(t=>`<option ${t===a.hora?'selected':''}>${esc(t)}</option>`).join('');
   slotsReady=times.length>0;f.hora.disabled=!slotsReady;notice.textContent=times.length?'Horários atualizados.':'Nenhum horário disponível para esta seleção. Escolha outra data ou profissional.';
  }catch(error){
   if(current!==version || !f.isConnected)return;
   f.hora.innerHTML='<option value="">Não foi possível carregar horários</option>';notice.textContent=error.message || 'Falha ao consultar horários. Tente novamente.';notice.classList.add('error');retry.hidden=false;
  }finally{
   inFlight=false;f.hora.setAttribute('aria-busy','false');updateSave();
   if(queued){queued=false;slots();}
  }
 };
 retry.onclick=slots;f.hora.onchange=updateSave;
 f.onsubmit=e=>{
  e.preventDefault();if(saving || agendaMutationInFlight || !slotsReady || inFlight || !f.hora.value)return;
  const body=Object.fromEntries(new FormData(f));
  if(a.id&&!confirm(`Confirmar a remarcação de ${body.nome_cliente} para ${body.data.split('-').reverse().join('/')} às ${body.hora}?`))return;
  saving=true;agendaMutationInFlight=true;f.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);message(a.id?'Remarcando agendamento…':'Salvando agendamento…');
  action(async()=>{let saved=false;try{await api('/agendamentos'+(a.id?'/'+a.id:''),a.id?'PUT':'POST',body);saved=true;await refresh();message(a.id?'Agendamento remarcado.':'Agendamento criado.');}
   catch(error){message(saved?'O agendamento foi salvo, mas não foi possível atualizar a Agenda. Tente atualizar novamente.':error.message,true);}
   finally{saving=false;agendaMutationInFlight=false;if(f.isConnected){f.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);f.hora.disabled=!slotsReady;updateSave();}lockAgendaActions(false);}});
 };
 const people=()=>{f.profissional_id.innerHTML=state.profissionais.filter(p=>p.ativo && p.servicos.includes(+f.servico_id.value)).map(p=>`<option value="${p.id}" ${p.id===a.profissional_id?'selected':''}>${esc(p.nome)}</option>`).join('');slots();};f.servico_id.onchange=people;f.profissional_id.onchange=slots;f.data.onchange=slots;people();
}
function pageForm(){const p=state.pagina;form('Personalizar minha página',`<p class="muted">Veja como sua página ficará para seus clientes antes de salvar.</p><div class="form-grid">${field('Nome do estabelecimento','nome','text',p.nome,'required maxlength="100"')}${field('Link público','slug','text',p.slug,'required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="80"')}${field('Telefone / WhatsApp','telefone','tel',p.telefone)}<label>Tipo de negócio<select name="businessType">${(state.businessTypes||[]).map(t=>`<option value="${esc(t.code)}" ${t.code===p.businessType?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>${field('Cidade','city','text',p.city,'maxlength="100"')}${field('Estado (UF)','state','text',p.state,'maxlength="2"')}${field('Endereço','address','text',p.address,'maxlength="250"')}${field('Instagram (usuário)','instagram','text',p.instagram,'maxlength="30"')}${field('Cor de destaque','cor','color',p.cor)}<label class="wide">Descrição<textarea name="descricao" maxlength="1000">${esc(p.descricao)}</textarea></label>${field('Capa (até 2 MB)','capa','file','','accept="image/png,image/jpeg,image/webp"')}${field('Logo (até 2 MB)','logo','file','','accept="image/png,image/jpeg,image/webp"')}<label><span><input type="checkbox" name="removeCover"> Remover capa</span></label><label><span><input type="checkbox" name="removeLogo"> Remover logo</span></label></div><button id="previewButton" type="button">Visualizar página</button><div id="preview" class="preview" hidden></div>`,async f=>api('/pagina','PUT',await payload(f)));
 async function payload(f){return {businessType:f.businessType.value,city:f.city.value,state:f.state.value,address:f.address.value,instagram:f.instagram.value,nome:f.nome.value,slug:f.slug.value,telefone:f.telefone.value,cor:f.cor.value,descricao:f.descricao.value,capa:f.removeCover.checked?null:await readFile(f.capa.files[0]) || p.capa,logo:f.removeLogo.checked?null:await readFile(f.logo.files[0]) || p.logo};}
 const editor=$('#editor');editor.classList.add('page-editor');let previewVersion=0;
 const preview=()=>action(async()=>{const version=++previewVersion,b=await payload(editor);if(version!==previewVersion || !editor.isConnected)return;const el=$('#preview');el.hidden=false;el.innerHTML=`<div class="cover"></div>${b.logo?`<img class="logo" src="${esc(b.logo)}" alt="Prévia do logo">`:''}<h2>${esc(b.nome)}</h2><p>${esc(b.descricao)}</p><p>${esc(b.telefone)}</p><button type="button" style="background:${esc(b.cor)}">Agendar meu horário</button>`;if(b.capa)el.querySelector('.cover').style.backgroundImage=`url("${b.capa}")`;});
 $('#previewButton').onclick=preview;
 editor.addEventListener('input',event=>{if(event.target.type!=='file')preview();});
 editor.addEventListener('change',event=>{
  if(event.target===editor.capa && editor.capa.files.length)editor.removeCover.checked=false;
  if(event.target===editor.logo && editor.logo.files.length)editor.removeLogo.checked=false;
  preview();
 });
 preview();
}
function hoursForm(){
 const days=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
 $('#view').innerHTML=`<div class="card"><h2>Horários de funcionamento</h2><p class="muted">Informe os intervalos separados por vírgula. Ex.: 08:00-12:00, 13:00-18:00. Deixe vazio nos dias de folga.</p><form id="hours" class="stack">${days.map((d,i)=>field(d,'day'+i,'text',state.horarios?.[i]?.map(p=>p.join('-')).join(', ') ?? (i===0?'':'08:00-12:00, 13:00-18:00'))).join('')}<button class="primary">Salvar horários</button></form></div><div class="card"><h2>Bloquear dia ou horário</h2><form id="block" class="form-grid">${field('Data','data','date','','required') }<label>Profissional<select name="profissional_id"><option value="">Todos</option>${state.profissionais.map(p=>`<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>${field('Início (vazio = dia inteiro)','hora','time')}${field('Fim','fim','time')}<button class="primary">Adicionar bloqueio</button></form></div>`+table(['Data','Início','Fim','Profissional',''],state.bloqueios.map(b=>[esc(b.data),esc(b.hora || 'Dia inteiro'),esc(b.fim || '—'),esc(state.profissionais.find(p=>p.id===b.profissional_id)?.nome || 'Todos'),`<button data-remove-block="${b.id}">Remover</button>`]));
 $('#hours').onsubmit=e=>{e.preventDefault();const f=e.currentTarget;action(async()=>{await api('/horarios','PUT',{horarios:days.map((_,i)=>f['day'+i].value.trim()?f['day'+i].value.split(',').map(p=>p.trim().split('-').map(x=>x.trim())):[])});message('Horários salvos.');await refresh();});};
 $('#block').onsubmit=e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.currentTarget));action(async()=>{await api('/bloqueios','POST',b);await refresh();});};document.querySelectorAll('[data-remove-block]').forEach(b=>b.onclick=()=>action(async()=>{await api('/bloqueios/'+b.dataset.removeBlock,'DELETE');await refresh();}));
}
$('#logout').onclick=()=>action(async()=>{window.StudiofyWhatsapp?.unmount();await fetch('/api/barbeiro/logout',{method:'POST',headers:{'x-barbeiro-token':token}});localStorage.removeItem('barbearia_auth_token');location.href='/login.html';});
action(async()=>{await refresh();if(account?.acesso?.liberado)window.StudiofyInbox?.refreshBadge(token);});
// Refresh read-only screens without overwriting a form being edited.
setInterval(()=>{if(!['Conversas','WhatsApp'].includes(section) && !document.hidden && account && !$('#view form'))action(refresh);},30000);

function shiftDate(date,n){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function renderAgenda(view,appointments){
 appointments=[...appointments].sort((a,b)=>(a.data+a.hora).localeCompare(b.data+b.hora)||a.id-b.id);
 appointments=appointments.filter(a=>!agendaProfessional || String(a.profissional_id)===agendaProfessional);
 const date=new Date(agendaDate+'T12:00:00Z'),start=shiftDate(agendaDate,-((date.getUTCDay()+6)%7));
 const days=Array.from({length:7},(_,i)=>shiftDate(start,i));
 view.innerHTML='<div class="agenda-toolbar"><div class="row"><button id="prevWeek" aria-label="Semana anterior">‹</button><button id="agendaToday">Hoje</button><button id="nextWeek" aria-label="Próxima semana">›</button><h2>'+date.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',month:'long',year:'numeric'})+'</h2></div><div class="row"><button id="agendaMode">'+(agendaMode==='week'?'Ver lista':'Ver calendário')+'</button><button id="newBooking" class="primary">+ Novo agendamento</button></div></div>';
 view.innerHTML+='<div class="agenda-filters"><div class="row" aria-label="Filtrar agendamentos">'+[['todos','Todos'],['hoje','Hoje'],['proximos','Próximos'],['concluidos','Concluídos'],['cancelados','Cancelados']].map(([key,label])=>`<button data-agenda-filter="${key}" aria-pressed="${agendaMode==='list'&&agendaFilter===key}">${label}</button>`).join('')+'</div><label>Profissional<select id="agendaProfessional"><option value="">Todos os profissionais</option>'+state.profissionais.map(p=>`<option value="${p.id}" ${agendaProfessional===String(p.id)?'selected':''}>${esc(p.nome)}</option>`).join('')+'</select></label></div>';
 if(agendaMode==='list'){
  const filtered=appointments.filter(a=>agendaFilter==='hoje'?a.data===today():agendaFilter==='proximos'?a.futuro===true&&agendaTiming(a).future&&a.status==='confirmado':agendaFilter==='concluidos'?a.status==='concluido'&&a.futuro===false&&agendaTiming(a).valid&&!agendaTiming(a).future:agendaFilter==='cancelados'?a.status==='cancelado':true);
  view.innerHTML+='<p class="muted">'+(agendaFilter==='proximos'?'Atendimentos agendados após o horário atual. ':agendaFilter==='hoje'?'Todos os status de hoje. ':'')+'Ordem cronológica · horário de São Paulo.</p>'+appointmentTable(filtered);bindAppointments();
 }
 else {
 const entries=appointments.filter(a=>days.includes(a.data)&&a.status!=='cancelado');
 const first=Math.min(8,...entries.map(a=>+a.hora.slice(0,2))),last=Math.max(19,...entries.map(a=>Math.ceil((+a.hora.slice(0,2)*60 + +a.hora.slice(3)+a.duracao)/60)));
 const hours=Array.from({length:last-first},(_,i)=>first+i);
 view.innerHTML+=(entries.length?'':'<p class="card empty" role="status">'+(agendaProfessional?'Nenhum agendamento para este profissional nesta semana.':'Nenhum agendamento nesta semana.')+'</p>')+'<div class="calendar-scroll card"><div class="week-calendar"><div class="calendar-corner"></div>'+days.map(d=>'<div class="calendar-day '+(d===today()?'is-today':'')+'" data-agenda-date="'+d+'"><small>'+new Date(d+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',weekday:'short'})+'</small><strong>'+d.slice(8)+'</strong></div>').join('')+'<div class="calendar-hours">'+hours.map(h=>'<span>'+String(h).padStart(2,'0')+':00</span>').join('')+'</div>'+days.map(d=>'<div class="calendar-lane" data-agenda-date="'+d+'" style="height:'+hours.length*64+'px">'+entries.filter(a=>a.data===d).map(a=>'<button class="calendar-event event-'+esc(a.status)+'" data-calendar-booking="'+a.id+'" style="top:'+((+a.hora.slice(0,2)-first)*60 + +a.hora.slice(3))/60*64+'px;min-height:'+Math.max(32,a.duracao/60*64-3)+'px"><strong>'+esc(a.hora)+' · '+esc(a.nome_cliente)+'</strong><span>'+esc(a.servico_nome)+'</span><small>'+esc(a.profissional||'')+'</small></button>').join('')+'</div>').join('')+'</div></div><p class="muted">Selecione um atendimento para ver detalhes. Use a lista para concluir, cancelar ou registrar falta; a remarcação está disponível somente para agendamentos futuros confirmados.</p>';
 document.querySelectorAll('[data-calendar-booking]').forEach(b=>b.onclick=()=>showBookingDetails(appointments.find(a=>a.id===+b.dataset.calendarBooking)));
 // Separate simultaneous appointments by professional instead of stacking them.
 const professionals=[...new Map(entries.map(a=>[String(a.profissional_id),a.profissional || 'Profissional principal'])).entries()].sort((a,b)=>a[1].localeCompare(b[1]));
 const count=Math.max(1,professionals.length),calendar=$('.week-calendar');
 calendar.style.gridTemplateColumns=`54px repeat(7,minmax(${count*125}px,1fr))`;calendar.style.minWidth=`${54+7*count*125}px`;
 document.querySelectorAll('.calendar-day').forEach(day=>day.insertAdjacentHTML('beforeend','<div class="calendar-professionals" style="grid-template-columns:repeat('+count+',1fr)">'+professionals.map(([,name])=>'<span title="'+esc(name)+'">'+esc(name)+'</span>').join('')+'</div>'));
 document.querySelectorAll('[data-calendar-booking]').forEach(b=>{
  const a=entries.find(a=>a.id===+b.dataset.calendarBooking),column=professionals.findIndex(([id])=>id===String(a.profissional_id));
  b.style.left=`calc(${column*100/count}% + 3px)`;b.style.right='auto';b.style.width=`calc(${100/count}% - 6px)`;
  b.title=`${a.hora} · ${a.nome_cliente} · ${a.servico_nome} · ${a.profissional || 'Profissional principal'} · ${money(a.preco || 0)} · ${statusLabel(a.status)}`;
  b.setAttribute('aria-label',b.title);b.querySelector('span').textContent=a.servico_nome+' · '+money(a.preco || 0);
 });
 }
 document.querySelectorAll('[data-agenda-filter]').forEach(b=>b.onclick=()=>{agendaFilter=b.dataset.agendaFilter;agendaMode='list';render();});
 $('#agendaProfessional').onchange=e=>{agendaProfessional=e.target.value;render();};
 $('#newBooking').onclick=()=>bookingForm();$('#agendaMode').onclick=()=>{agendaMode=agendaMode==='week'?'list':'week';render();};$('#agendaToday').onclick=()=>{agendaDate=today();if(agendaMode==='list')agendaFilter='hoje';render();};$('#prevWeek').onclick=()=>{agendaDate=shiftDate(agendaDate,-7);render();};$('#nextWeek').onclick=()=>{agendaDate=shiftDate(agendaDate,7);render();};
}
