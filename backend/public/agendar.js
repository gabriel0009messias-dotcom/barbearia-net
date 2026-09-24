const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const endpoint='/api/studiofy/public/'+encodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
let salon,chosen,professional,date,hour,customer,phone;
async function api(path='',body){const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error || 'Não foi possível carregar.');return data;}
function error(e){$('#message').textContent=e.message;$('#message').classList.add('error');}
function services(){
 $('#booking').innerHTML='<p class="eyebrow">1. Escolha seu cuidado</p><h2>Serviços</h2><div class="grid">'+salon.servicos.map(s=>`<article class="card">${s.foto?`<img class="service-photo" src="${esc(s.foto)}" alt="">`:''}<h3>${esc(s.nome)}</h3><p class="muted">${esc(s.categoria || '')}</p><p class="muted">${esc(s.descricao)}</p><p>${money(s.preco)} <span class="muted">· ${s.duracao} min</span></p><button class="primary" data-service="${s.id}">Agendar</button></article>`).join('')+'</div>';
 if(!salon.servicos.length)$('#booking').innerHTML='<div class="card">Nenhum serviço disponível no momento.</div>';
 document.querySelectorAll('[data-service]').forEach(b=>b.onclick=()=>{chosen=salon.servicos.find(s=>s.id===Number(b.dataset.service));details();});
}
function details(){
 const compatible=salon.profissionais.filter(p=>p.servicos.includes(chosen.id));
 $('#booking').innerHTML=`<div class="card"><p class="eyebrow">2. Escolha quando</p><h2>${esc(chosen.nome)}</h2><p class="muted">${money(chosen.preco)} · ${chosen.duracao} minutos</p><form id="details" class="stack"><label>Profissional<select id="professional" required>${compatible.map(p=>`<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label><label>Data<input id="date" type="date" required min="${new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date())}"></label><div id="slots" class="slots" aria-label="Horários disponíveis">Escolha uma data para consultar os horários.</div><label>Seu nome<input id="name" autocomplete="name" required minlength="2" maxlength="100" value="${esc(customer || '')}"></label><label>Seu WhatsApp<input id="phone" type="tel" autocomplete="tel" required maxlength="20" value="${esc(phone || '')}"></label><div class="row"><button type="button" id="back">Voltar</button><button class="primary" id="review">Revisar agendamento</button></div></form></div>`;
 if(!compatible.length){$('#slots').textContent='Nenhum profissional disponível para este serviço.';$('#review').disabled=true;}
 let revision=0;hour=null;
 const load=async()=>{const current=++revision;hour=null;$('#slots').textContent='Consultando horários…';try{const times=await api('/horarios?'+new URLSearchParams({data:$('#date').value,profissional_id:$('#professional').value,servico_id:chosen.id}));if(current!==revision)return;$('#slots').innerHTML=times.length?times.map(t=>`<button type="button" data-time="${t}">${t}</button>`).join(''):'Sem horários disponíveis nesta data. Escolha outro dia.';document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{hour=b.dataset.time;document.querySelectorAll('[data-time]').forEach(x=>x.classList.toggle('selected',x===b));});}catch(e){error(e);}};
 $('#date').onchange=load;$('#professional').onchange=()=>{if($('#date').value)load();};$('#back').onclick=services;
 $('#details').onsubmit=e=>{e.preventDefault();if(!hour)return error(Error('Escolha um horário disponível.'));professional=compatible.find(p=>p.id===Number($('#professional').value));date=$('#date').value;customer=$('#name').value.trim();phone=$('#phone').value;review();};
}
function review(){
 $('#booking').innerHTML=`<div class="card"><p class="eyebrow">3. Confira os detalhes</p><h2>Revisar agendamento</h2><p>Serviço: <strong>${esc(chosen.nome)}</strong></p><p>Profissional: ${esc(professional.nome)}</p><p>Data: ${date.split('-').reverse().join('/')} às ${hour}</p><p>Duração: ${chosen.duracao} minutos</p><p>Valor: <strong>${money(chosen.preco)}</strong></p><p>${esc(customer)} · ${esc(phone)}</p><div class="row"><button id="edit">Alterar</button><button class="primary" id="confirm">Confirmar agendamento</button></div></div>`;
 $('#edit').onclick=details;$('#confirm').onclick=async()=>{const b=$('#confirm');b.disabled=true;try{const result=await api('/agendamentos',{nome_cliente:customer,telefone:phone,servico_id:chosen.id,profissional_id:professional.id,data:date,hora:hour});$('#message').textContent='';remember(result.token);showReservation(result.token,result.agendamento,true);}catch(e){error(e);b.disabled=false;}};
}
const bookingStorage='studiofy_public_bookings';
function remembered(){try{const tokens=JSON.parse(localStorage.getItem(bookingStorage)||'[]');return Array.isArray(tokens)?tokens.filter(t=>typeof t==='string' && /^[a-f0-9]{64}$/.test(t)):[];}catch{return [];}}
function remember(token){try{localStorage.setItem(bookingStorage,JSON.stringify([...new Set([token,...remembered()])]));}catch{error(Error('Não foi possível guardar neste navegador. Copie o link privado abaixo para acessar sua reserva depois.'));}}
async function reservationApi(action,token,extra={}){
 const r=await fetch('/api/studiofy/public/reservas/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,...extra}),cache:'no-store'});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Não foi possível consultar seu agendamento.');return data;
}
function bookingDetails(a){return `<h3>${esc(a.estabelecimento)}</h3><p>${esc(a.servico)} · ${esc(a.profissional||'Profissional principal')}<br>${esc(a.data.split('-').reverse().join('/'))} às ${esc(a.hora)} · ${a.duracao} min<br>${money(a.preco)}</p>`;}
function showReservation(token,a,created=false){
 $('#booking').innerHTML=`<div class="card"><span class="pill">${esc(a.status)}</span><h2 style="margin-top:20px">${created?'Agendamento confirmado!':a.status==='cancelado'?'Agendamento cancelado com sucesso.':'Seu agendamento'}</h2>${created?'<p>Seu horário foi reservado com sucesso.</p>':''}${bookingDetails(a)}${a.cancelavel?'<button id="cancelBooking" type="button">Cancelar agendamento</button>':`<p class="muted">${esc(a.motivo||'')}</p>`}<p class="muted">${a.antecedencia_minutos?`Cancelamento com pelo menos ${a.antecedencia_minutos} minutos de antecedência.`:'Cancelamento permitido antes do início do atendimento.'}</p><label>Link privado do agendamento<input id="privateBookingLink" readonly value="${esc(location.origin+'/agendar/'+encodeURIComponent(a.slug)+'#reserva='+token)}"></label><p class="muted">Guarde este link. Quem tiver acesso a ele poderá consultar e cancelar esta reserva.</p><button type="button" id="myBookings">Meus agendamentos</button></div>`;
 $('#myBookings').onclick=()=>myBookings();
 const back=document.createElement('a');back.className='button';back.href='/agendar/'+encodeURIComponent(a.slug);back.textContent='Ver serviços';$('#myBookings').after(document.createTextNode(' '),back);
 if($('#cancelBooking'))$('#cancelBooking').onclick=()=>confirmCancellation(token,a);
}
function confirmCancellation(token,a){
 const dialog=document.createElement('dialog');dialog.className='cancel-dialog';dialog.setAttribute('aria-labelledby','cancelTitle');
 dialog.innerHTML='<h2 id="cancelTitle">Deseja realmente cancelar este agendamento?</h2>'+bookingDetails(a)+'<div class="row"><button type="button" id="cancelBack">Voltar</button><button type="button" id="confirmCancellation" class="primary">Confirmar cancelamento</button></div><p role="alert" class="error" id="cancelError"></p>';
 document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('#cancelBack').onclick=()=>dialog.close();
 dialog.querySelector('#confirmCancellation').onclick=async()=>{
  const button=dialog.querySelector('#confirmCancellation');button.disabled=true;
  try{const result=await reservationApi('cancelar',token,{confirmar:true});dialog.close();showReservation(token,result);$('#message').textContent='';}
  catch(e){dialog.querySelector('#cancelError').textContent=e.message;button.disabled=false;}
 };dialog.showModal();dialog.querySelector('#cancelBack').focus();
}
let listVersion=0;
async function myBookings(offset=0){
 const version=++listVersion,tokens=remembered();
 $('#booking').innerHTML='<div class="card"><h2>Meus agendamentos</h2><p class="muted">Reservas futuras guardadas neste navegador. Em outro aparelho, abra o link privado da reserva. Não compartilhe esses links.</p><div id="savedBookings">Consultando…</div></div>';
 try{
  const entries=await Promise.all(tokens.slice(offset,offset+20).map(async token=>{try{return {token,a:await reservationApi('consultar',token)};}catch{return {token,error:true};}}));
  if(version!==listVersion || !$('#savedBookings'))return;
  const future=entries.filter(x=>x.a?.futuro && x.a.status!=='cancelado').sort((x,y)=>new Date(x.a.inicio)-new Date(y.a.inicio));
  $('#savedBookings').innerHTML=future.map(({token,a})=>`<article class="saved-booking">${bookingDetails(a)}<button type="button" data-reservation="${token}">Ver agendamento</button>${a.cancelavel?` <button type="button" data-cancel-reservation="${token}">Cancelar agendamento</button>`:`<p class="muted">${esc(a.motivo)}</p>`}</article>`).join('') || '<p>Nenhum agendamento futuro disponível nesta lista.</p>';
  if(entries.some(x=>x.error))$('#savedBookings').insertAdjacentHTML('beforeend','<p class="error">Não foi possível consultar algumas reservas. Tente novamente mais tarde ou abra seu link privado.</p>');
  if(salon){const back=document.createElement('button');back.textContent='Ver serviços';back.onclick=services;$('#savedBookings').after(back);}
  for(const button of document.querySelectorAll('[data-reservation]'))button.onclick=()=>showReservation(button.dataset.reservation,entries.find(x=>x.token===button.dataset.reservation).a);
  for(const button of document.querySelectorAll('[data-cancel-reservation]'))button.onclick=()=>confirmCancellation(button.dataset.cancelReservation,entries.find(x=>x.token===button.dataset.cancelReservation).a);
  if(offset>0){const previous=document.createElement('button');previous.textContent='Anteriores';previous.onclick=()=>myBookings(offset-20);$('#savedBookings').append(previous);}
  if(tokens.length>offset+20){const next=document.createElement('button');next.textContent='Mais agendamentos';next.onclick=()=>myBookings(offset+20);$('#savedBookings').append(next);}
 }catch(e){error(e);}
}
const privateToken=new URLSearchParams(location.hash.slice(1)).get('reserva');
if(privateToken){history.replaceState(null,'',location.pathname);reservationApi('consultar',privateToken).then(a=>{remember(privateToken);showReservation(privateToken,a);}).catch(error);}

else api().then(data=>{salon=data;document.documentElement.style.setProperty('--blue',data.cor);$('#salon').innerHTML=`<div class="cover" id="cover"></div>${data.logo?`<img class="logo" alt="Logo do estabelecimento" src="${esc(data.logo)}">`:''}<div class="public-title"><h1>${esc(data.nome)}</h1><p class="muted">${esc(data.descricao)}</p><p>${esc([data.address,data.city,data.state].filter(Boolean).join(' - '))}</p>${data.instagram?`<a class="button" target="_blank" rel="noopener noreferrer" href="https://www.instagram.com/${encodeURIComponent(data.instagram)}/">Instagram</a>`:''}${data.telefone?`<a class="button" target="_blank" rel="noopener" href="https://wa.me/${data.telefone.replace(/\D/g,'').replace(/^(\d{10,11})$/,'55$1')}">Falar com o estabelecimento</a>`:''}</div>`;if(data.capa)$('#cover').style.backgroundImage=`url("${data.capa}")`;services();}).catch(error);
$('#openMyBookings').onclick=()=>myBookings();
