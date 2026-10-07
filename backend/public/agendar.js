const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const endpoint='/api/studiofy/public/'+encodeURIComponent(location.pathname.split('/').filter(Boolean).pop());
let salon,chosen,professional,date,hour,customer,phone,detailsVersion=0;
let viewController=new AbortController(),confirmationBusy=false;
let retryUntil=0,rateTimer;
try{retryUntil=Number(sessionStorage.getItem('studiofy_public_retry_until'))||0;}catch{}
function rateError(){return Object.assign(Error('Muitas tentativas. Aguarde '+Math.max(1,Math.ceil((retryUntil-Date.now())/1000))+' segundos antes de tentar novamente.'),{status:429});}
function rateControls(){
 clearTimeout(rateTimer);
 const waiting=Date.now()<retryUntil;
 for(const selector of ['#confirm','#recoverBooking','#retrySlots','#retryPage','#confirmCancellation']){
  const button=$(selector);if(!button)continue;
  if(waiting){if(!button.hasAttribute('data-rate-disabled'))button.dataset.rateDisabled=String(button.disabled);button.disabled=true;}
  else if(button.hasAttribute('data-rate-disabled')){button.disabled=['#confirm','#recoverBooking'].includes(selector)&&confirmationBusy;delete button.dataset.rateDisabled;}
 }
 if(waiting)rateTimer=setTimeout(rateControls,Math.min(1000,retryUntil-Date.now()));
}
function waitAfter(value){
 const seconds=Number(value),until=value&&Number.isFinite(seconds)?Date.now()+Math.max(0,seconds)*1000:Date.parse(value);
 retryUntil=Math.max(retryUntil,Number.isFinite(until)?until:Date.now()+60000);
 try{sessionStorage.setItem('studiofy_public_retry_until',String(retryUntil));}catch{}
 rateControls();
}
function imageFallbacks(container){
 for(const img of container.querySelectorAll('img')){
  const fallback=()=>{const box=document.createElement('div');box.className=img.className+' image-fallback';box.setAttribute('aria-label','Imagem indisponível');box.textContent=img.classList.contains('logo')?'S':'Imagem indisponível';img.replaceWith(box);};
  img.addEventListener('error',fallback,{once:true});if(img.complete&&!img.naturalWidth)fallback();
 }
}
function safeMessage(e){
 if(e.status===429)return rateError().message;
 if([403,404].includes(e.status))return 'Este estabelecimento ou agendamento está indisponível. Confira o link ou fale com o estabelecimento.';
 if(e.status>=500)return 'O serviço está temporariamente indisponível. Tente novamente em instantes.';
 if(e.status===400)return 'Confira os dados informados e tente novamente.';
 if(e.status)return 'Não foi possível concluir. Confira os dados ou tente novamente mais tarde.';
 if(e instanceof TypeError)return 'Não foi possível conectar. Confira sua internet e tente novamente.';
 return e.message||'Não foi possível concluir. Tente novamente.';
}
function navigate(){$('#booking').setAttribute('aria-busy','false');detailsVersion++;viewController.abort();viewController=new AbortController();return detailsVersion;}
const pendingStorage='studiofy_public_pending:'+endpoint;
let pending;
function readPending(){
 try{
  const attempts=Object.keys(localStorage).filter(k=>k.startsWith(pendingStorage+':')).map(k=>{try{return JSON.parse(localStorage.getItem(k));}catch{return null;}})
   .filter(saved=>saved && /^[a-f0-9]{64}$/.test(saved.key) && saved.body && typeof saved.body==='object');
  return attempts.sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))[0];
 }catch{return null;}
}
pending=readPending();
function savePending(value){
 // Persist before POST. If storage is unavailable, do not risk an unrecoverable creation.
 value.createdAt=Date.now();localStorage.setItem(pendingStorage+':'+value.key,JSON.stringify(value));pending=value;pendingNotice();
}
function clearPending(operation){try{localStorage.removeItem(pendingStorage+':'+operation.key);}catch{}pending=readPending();pendingNotice();}
function pendingNotice(){
 let banner=$('#pendingBooking');if(!banner){banner=document.createElement('div');banner.id='pendingBooking';banner.className='card';$('#booking').before(banner);}
 banner.hidden=!pending;if(!pending)return;
 banner.innerHTML='<p role="status">Ainda precisamos verificar sua reserva. Use Recuperar confirmação e aguarde: não é necessário confirmar várias vezes.</p><button type="button" id="recoverBooking">Recuperar confirmação</button>';
 $('#recoverBooking').disabled=confirmationBusy;rateControls();$('#recoverBooking').onclick=()=>{if(confirmationBusy)return;const version=navigate();$('#booking').innerHTML='<div class="card">Recuperando confirmação…</div>';submitConfirmation(version,true);};
}
function newKey(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');}
async function requestJson(url,body,options={}){
 if(Date.now()<retryUntil)throw rateError();
 const attempts=options.retry?2:1,mutation=!!body&&!options.retry;
 for(let attempt=0;attempt<attempts;attempt++){
  if(options.signal?.aborted)throw new DOMException('Navegação alterada.','AbortError');
  const controller=new AbortController(),abort=()=>controller.abort();
  options.signal?.addEventListener('abort',abort,{once:true});
  let timer,timedOut=false;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(Object.assign(Error(mutation?'Não foi possível confirmar o resultado. Consulte seu agendamento antes de tentar novamente.':'A consulta demorou demais. Tente novamente.'),{uncertain:mutation,timeout:true}));},mutation?15000:10000);});
   const work=(async()=>{
    const r=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(options.key?{'Idempotency-Key':options.key}:{})},body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});
    if(r.status===429){waitAfter(r.headers.get('Retry-After'));throw rateError();}
    let data;try{data=await r.json();}catch{throw Object.assign(Error('Não foi possível ler a resposta. Tente novamente em instantes.'),{status:r.ok?undefined:r.status,uncertain:mutation});}
    if(!r.ok)throw Object.assign(Error('Não foi possível concluir a solicitação.'),{status:r.status,code:data.code,uncertain:mutation&&r.status>=500});return data;
   })();
   return await Promise.race([work,timeout]);
  }catch(e){
   if(options.signal?.aborted)throw new DOMException('Navegação alterada.','AbortError');
   if(timedOut&&!e.timeout)e=Object.assign(Error(mutation?'Não foi possível confirmar o resultado. Consulte seu agendamento antes de tentar novamente.':'A consulta demorou demais. Tente novamente.'),{timeout:true,uncertain:mutation});
   if(mutation&&!e.status)e.uncertain=true;
   const transient=e.timeout || !e.status || [502,503,504].includes(e.status);
   if(attempt+1<attempts && transient){await new Promise(resolve=>setTimeout(resolve,250));continue;}
   throw e;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
 }
}
async function api(path='',body,options={}){return requestJson(endpoint+path,body,{retry:!body,signal:body?undefined:viewController.signal,...options});}

function error(e){$('#message').textContent=safeMessage(e);$('#message').classList.add('error');$('#message').focus({preventScroll:true});$('#message').scrollIntoView({block:'nearest'});rateControls();}
function clearMessage(){$('#message').textContent='';$('#message').classList.remove('error');}
function focusStep(){const heading=$('#booking h2');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});heading.scrollIntoView({block:'start'});}}
function services(){
 navigate();clearMessage();
 $('#booking').innerHTML='<p class="eyebrow">1. Escolha seu cuidado</p><h2>Serviços</h2><div class="grid">'+salon.servicos.map(s=>`<article class="card">${s.foto?`<img class="service-photo" src="${esc(s.foto)}" alt="">`:'<div class="service-photo image-fallback" aria-hidden="true">Imagem não adicionada</div>'}<h3>${esc(s.nome)}</h3><p class="muted">${esc(s.categoria || '')}</p><p class="muted">${esc(s.descricao)}</p><p>${money(s.preco)} <span class="muted">· ${s.duracao} min</span></p><button class="primary" data-service="${s.id}">Agendar</button></article>`).join('')+'</div>';
 if(!salon.servicos.length)$('#booking').innerHTML='<div class="card">Nenhum serviço disponível no momento.</div>';
 imageFallbacks($('#booking'));
 focusStep();
 document.querySelectorAll('[data-service]').forEach(b=>b.onclick=()=>{const next=salon.servicos.find(s=>s.id===Number(b.dataset.service));if(chosen?.id!==next.id){professional=null;hour=null;}chosen=next;details();});
}
function details(){
 const version=navigate();clearMessage();
 const compatible=salon.profissionais.filter(p=>p.servicos.includes(chosen.id));
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date()),last=new Date(today+'T12:00:00Z');last.setUTCDate(last.getUTCDate()+90);
 $('#booking').innerHTML=`<div class="card"><p class="eyebrow">2. Escolha quando</p><h2>${esc(chosen.nome)}</h2><p class="muted">${money(chosen.preco)} · ${chosen.duracao} minutos</p><form id="details" class="stack"><label for="professional">Profissional<select id="professional" required ${compatible.length===1?'disabled':''}>${compatible.map(p=>`<option value="${p.id}" ${p.id===professional?.id?'selected':''}>${esc(p.nome)}</option>`).join('')}</select></label>${compatible.length===1?'<p class="muted">Profissional selecionado para este serviço.</p>':''}<label for="date">Data<input id="date" type="date" required min="${today}" max="${last.toISOString().slice(0,10)}" value="${esc(date || '')}"></label><p class="muted">Escolha a data e o horário. Depois, informe seus dados para revisar antes de confirmar.</p><div id="slots" class="slots" aria-label="Horários disponíveis" aria-live="polite">Escolha uma data para consultar os horários.</div><label for="name">Seu nome<input id="name" autocomplete="name" required minlength="2" maxlength="100" value="${esc(customer || '')}"></label><label for="phone">Telefone de contato<input id="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="20" value="${esc(phone || '')}" placeholder="DDD + número"></label><div class="row"><button type="button" id="back">Voltar</button><button class="primary" id="review" disabled>Revisar agendamento</button></div></form></div>`;
 if(!compatible.length){$('#slots').textContent='Nenhum profissional disponível para este serviço.';$('#review').disabled=true;}
 let revision=0,slotsController;const previousHour=hour;hour=null;
 const save=()=>{customer=$('#name').value;phone=$('#phone').value;date=$('#date').value;professional=compatible.find(p=>p.id===Number($('#professional').value));};
 const load=async(preferred=null)=>{
  slotsController?.abort();slotsController=new AbortController();const slotOperation=slotsController,viewSignal=viewController.signal,abortSlots=()=>slotOperation.abort();const current=++revision;hour=null;$('#review').disabled=true;$('#slots').setAttribute('aria-busy','false');clearMessage();
  if(!$('#date').value || !$('#date').validity.valid){$('#slots').textContent='Escolha uma data válida, de hoje até 90 dias.';return;}
  if(!compatible.length)return;
  $('#slots').textContent='Consultando horários…';$('#slots').setAttribute('aria-busy','true');
  viewSignal.addEventListener('abort',abortSlots,{once:true});
  try{
   const times=await api('/horarios?'+new URLSearchParams({data:$('#date').value,profissional_id:$('#professional').value,servico_id:chosen.id}),undefined,{signal:slotsController.signal});
   if(current!==revision||version!==detailsVersion||!$('#slots'))return;
   $('#slots').innerHTML=times.length?times.map(t=>`<button type="button" data-time="${t}" aria-pressed="false">${t}</button>`).join(''):'Sem horários disponíveis nesta data. Escolha outro dia.';
   document.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{hour=b.dataset.time;$('#review').disabled=false;document.querySelectorAll('[data-time]').forEach(x=>{x.classList.toggle('selected',x===b);x.setAttribute('aria-pressed',String(x===b));});});
   if(preferred&&times.includes(preferred))document.querySelector(`[data-time="${preferred}"]`).click();
  }catch(e){if(e.name==='AbortError'||current!==revision||version!==detailsVersion||!$('#slots'))return;$('#slots').innerHTML='Não foi possível consultar os horários. <button type="button" id="retrySlots">Tentar novamente</button>';$('#retrySlots').onclick=()=>load();error(e);}
  finally{viewSignal.removeEventListener('abort',abortSlots);if(current===revision&&version===detailsVersion)$('#slots')?.setAttribute('aria-busy','false');}
 };
 $('#date').onchange=()=>{save();load();};$('#professional').onchange=()=>{save();if($('#date').value)load();};$('#back').onclick=()=>{save();services();};
 $('#details').onsubmit=e=>{e.preventDefault();save();if(!hour)return error(Error('Escolha um horário disponível.'));if(customer.trim().length<2||!/^\d{10,15}$/.test(phone.replace(/\D/g,'')))return error(Error('Informe seu nome e um telefone com DDD válido.'));customer=customer.trim();review();};
 if(date)load(previousHour);
 focusStep();
}
function review(){
 navigate();clearMessage();
 $('#booking').innerHTML=`<div class="card"><p class="eyebrow">3. Confira os detalhes</p><h2>Revisar agendamento</h2><p>Estabelecimento: <strong>${esc(salon.nome)}</strong></p><p>Serviço: <strong>${esc(chosen.nome)}</strong></p><p>Profissional: ${esc(professional.nome)}</p><p>Data: ${date.split('-').reverse().join('/')} às ${hour}</p><p>Duração: ${chosen.duracao} minutos</p><p>Valor: <strong>${money(chosen.preco)}</strong></p><p>${esc(customer)} · ${esc(phone)}</p><div class="row"><button id="edit">Alterar</button><button class="primary" id="confirm">Confirmar agendamento</button></div></div>`;
 const version=detailsVersion;
 focusStep();
 if(pending)$('#confirm').textContent='Recuperar confirmação pendente';
 $('#edit').onclick=details;$('#confirm').onclick=()=>{
  if(confirmationBusy||version!==detailsVersion)return;
  pending=pending||readPending();
  const recovery=!!pending;
  if(!pending){
   try{savePending({key:newKey(),body:{nome_cliente:customer,telefone:phone,servico_id:chosen.id,profissional_id:professional.id,data:date,hora:hour}});}
   catch{return error(Error('Não foi possível guardar a tentativa neste navegador. Permita o armazenamento para confirmar com segurança.'));}
  }
  submitConfirmation(version,recovery);
 };
}
async function submitConfirmation(version,recovery=false){
 if(confirmationBusy||!pending)return;
 confirmationBusy=true;pendingNotice();
 const b=$('#confirm'),edit=$('#edit'),operation=pending;
 if(b){b.disabled=true;b.textContent=recovery?'Recuperando confirmação…':'Confirmando…';}if(edit)edit.disabled=true;
 $('#booking').setAttribute('aria-busy','true');
 try{
  // No automatic retry of a mutation. A manual recovery resends the exact stored
  // payload and key, which the backend resolves to the original committed receipt.
  let result;
  if(recovery){
   try{result=await requestJson('/api/studiofy/public/reservas/recuperar',{chave:operation.key,solicitacao:operation.body},{retry:true});}
   catch(e){if(e.status!==404||e.code!=='CONFIRMATION_NOT_FOUND')throw e;}
  }
  if(!result)result=await api('/agendamentos',operation.body,{key:operation.key});
  const stored=remember(result.token);if(stored)clearPending(operation);
  if(version!==detailsVersion)return;
  clearMessage();showReservation(result.token,result.agendamento,result.agendamento.status==='confirmado'&&result.agendamento.futuro);
  if(!stored)error(Error('Copie o link privado abaixo. A tentativa foi mantida para recuperar depois.'));
 }catch(e){
  if(e.status===400||e.status===409)clearPending(operation);
  if(version!==detailsVersion)return;
  if(e.status===409){
   try{
    const fresh=await api();if(version!==detailsVersion)return;
    salon=fresh;hour=null;const current=salon.servicos.find(s=>s.id===chosen?.id);
    if(current){chosen=current;const available=salon.profissionais.some(p=>p.id===professional?.id&&p.servicos.includes(current.id));details();error(Error(available?'Esse horário não está mais disponível. Seus dados foram mantidos; escolha outro horário para continuar.':'Esse profissional não está mais disponível para o serviço. Seus dados foram mantidos; escolha um profissional disponível para continuar.'));}
    else{services();error(Error('Esse serviço não está mais disponível. Escolha outro serviço para continuar.'));}
   }catch(refreshError){if(version===detailsVersion)error(refreshError);}
  }else{
   error(e.uncertain?Error('Não foi possível confirmar se a reserva foi criada. Use Recuperar confirmação; a mesma tentativa não cria outra reserva.'):e);
   if(!b)$('#booking').innerHTML='<div class="card">A confirmação ainda não pôde ser recuperada. Use o botão acima para tentar novamente.</div>';
  }
 }finally{
  confirmationBusy=false;pendingNotice();if(version===detailsVersion)$('#booking').setAttribute('aria-busy','false');
  if(version===detailsVersion&&b?.isConnected){b.disabled=false;b.textContent=pending?'Recuperar confirmação':'Confirmar agendamento';if(edit)edit.disabled=false;}
  rateControls();
 }
}

const bookingStorage='studiofy_public_bookings';
function remembered(){try{const tokens=JSON.parse(localStorage.getItem(bookingStorage)||'[]');return Array.isArray(tokens)?tokens.filter(t=>typeof t==='string' && /^[a-f0-9]{64}$/.test(t)):[];}catch{return [];}}
function remember(token){try{localStorage.setItem(bookingStorage,JSON.stringify([...new Set([token,...remembered()])]));return true;}catch{return false;}}
async function reservationApi(action,token,extra={}){
 return requestJson('/api/studiofy/public/reservas/'+action,{token,...extra},{retry:action==='consultar',signal:action==='consultar'?viewController.signal:undefined});
}
function bookingDetails(a){return `<h3>${esc(a.estabelecimento)}</h3><p>${esc(a.servico)} · ${esc(a.profissional||'Profissional principal')}<br>${esc(a.data.split('-').reverse().join('/'))} às ${esc(a.hora)} · ${a.duracao} min<br>${money(a.preco)}</p>`;}
function announceEstablishment(name){document.body.dataset.establishmentName=name;document.dispatchEvent(new CustomEvent("studiofy:establishment",{detail:{name}}));}
function showReservation(token,a,created=false){
 navigate();clearMessage();
 announceEstablishment(a.estabelecimento);
 $('#booking').innerHTML=`<div class="card"><span class="pill">${esc(a.status)}</span><h2 style="margin-top:20px">${created?'Agendamento confirmado!':a.status==='cancelado'?'Agendamento cancelado com sucesso.':'Seu agendamento'}</h2>${created?'<p>Seu horário foi reservado com sucesso.</p>':''}${bookingDetails(a)}${a.cancelavel?'<button id="cancelBooking" type="button">Cancelar agendamento</button>':`<p class="muted">${esc(a.motivo||'')}</p>`}<p class="muted">${a.antecedencia_minutos?`Cancelamento com pelo menos ${a.antecedencia_minutos} minutos de antecedência.`:'Cancelamento permitido antes do início do atendimento.'}</p><label for="privateBookingLink">Link privado do agendamento<input id="privateBookingLink" type="hidden" readonly value="${esc(location.origin+'/agendar/'+encodeURIComponent(a.slug)+'#reserva='+token)}"></label><a class="button" id="openPrivateBooking" href="${esc(location.origin+'/agendar/'+encodeURIComponent(a.slug)+'#reserva='+token)}">Abrir acesso privado</a><button type="button" id="copyPrivateBooking">Copiar link privado</button><p class="muted">Guarde este link. Quem tiver acesso a ele poderá consultar e cancelar esta reserva.</p><button type="button" id="myBookings">Meus agendamentos</button></div>`;
 focusStep();
 $('#copyPrivateBooking').onclick=async()=>{
  try{await navigator.clipboard.writeText($('#privateBookingLink').value);$('#message').textContent='Link privado copiado. Guarde-o em um lugar seguro.';}
  catch{const input=$('#privateBookingLink');input.type='text';input.focus();input.select();$('#message').textContent='Selecione e copie o link privado. Guarde-o em um lugar seguro.';}
 };
 $('#myBookings').onclick=()=>myBookings();
 const back=document.createElement('a');back.className='button';back.href='/agendar/'+encodeURIComponent(a.slug);back.textContent='Ver serviços';$('#myBookings').after(document.createTextNode(' '),back);
 if($('#cancelBooking'))$('#cancelBooking').onclick=()=>confirmCancellation(token,a);
}
function confirmCancellation(token,a){
 const version=detailsVersion;const dialog=document.createElement('dialog');dialog.className='cancel-dialog';dialog.setAttribute('aria-labelledby','cancelTitle');
 dialog.innerHTML='<h2 id="cancelTitle">Deseja realmente cancelar este agendamento?</h2>'+bookingDetails(a)+'<div class="row"><button type="button" id="cancelBack">Voltar</button><button type="button" id="confirmCancellation" class="primary">Confirmar cancelamento</button></div><p role="alert" class="error" id="cancelError"></p>';
 document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove());dialog.querySelector('#cancelBack').onclick=()=>dialog.close();
 dialog.querySelector('#confirmCancellation').onclick=async()=>{
  const button=dialog.querySelector('#confirmCancellation');button.disabled=true;
  try{const result=await reservationApi('cancelar',token,{confirmar:true});dialog.close();if(version===detailsVersion){showReservation(token,result);$('#message').textContent='';}}
  catch(e){dialog.querySelector('#cancelError').textContent=safeMessage(e);button.disabled=false;rateControls();}
 };dialog.showModal();dialog.querySelector('#cancelBack').focus();
}
let listVersion=0;
async function myBookings(offset=0){
 const view=navigate(),version=++listVersion,tokens=remembered();
 $('#booking').innerHTML='<div class="card"><h2>Meus agendamentos</h2><p class="muted">Reservas futuras guardadas neste navegador. Em outro aparelho, abra o link privado da reserva. Não compartilhe esses links.</p><div id="savedBookings">Consultando…</div></div>';
 try{
  const entries=await Promise.all(tokens.slice(offset,offset+20).map(async token=>{try{return {token,a:await reservationApi('consultar',token)};}catch{return {token,error:true};}}));
  if(view!==detailsVersion || version!==listVersion || !$('#savedBookings'))return;
  const future=entries.filter(x=>x.a?.futuro && x.a.status!=='cancelado').sort((x,y)=>new Date(x.a.inicio)-new Date(y.a.inicio));
  $('#savedBookings').innerHTML=future.map(({token,a})=>`<article class="saved-booking">${bookingDetails(a)}<button type="button" data-reservation="${token}">Ver agendamento</button>${a.cancelavel?` <button type="button" data-cancel-reservation="${token}">Cancelar agendamento</button>`:`<p class="muted">${esc(a.motivo)}</p>`}</article>`).join('') || '<p>Nenhum agendamento futuro disponível nesta lista.</p>';
  if(entries.some(x=>x.error)){
   $('#savedBookings').insertAdjacentHTML('beforeend','<p role="alert" class="error">Não foi possível consultar algumas reservas. Tente novamente mais tarde ou abra seu link privado.</p><button type="button" id="retryPage">Tentar novamente</button>');
   $('#retryPage').onclick=()=>myBookings(offset);rateControls();
  }
  if(salon){const back=document.createElement('button');back.textContent='Ver serviços';back.onclick=services;$('#savedBookings').after(back);}
  for(const button of document.querySelectorAll('[data-reservation]'))button.onclick=()=>showReservation(button.dataset.reservation,entries.find(x=>x.token===button.dataset.reservation).a);
  for(const button of document.querySelectorAll('[data-cancel-reservation]'))button.onclick=()=>confirmCancellation(button.dataset.cancelReservation,entries.find(x=>x.token===button.dataset.cancelReservation).a);
  if(offset>0){const previous=document.createElement('button');previous.textContent='Anteriores';previous.onclick=()=>myBookings(offset-20);$('#savedBookings').append(previous);}
  if(tokens.length>offset+20){const next=document.createElement('button');next.textContent='Mais agendamentos';next.onclick=()=>myBookings(offset+20);$('#savedBookings').append(next);}
 }catch(e){if(view===detailsVersion)error(e);}
}
pendingNotice();
$('#booking').innerHTML='<div class="card" role="status">Carregando serviços e profissionais…</div>';
const initialVersion=detailsVersion;
const privateToken=new URLSearchParams(location.hash.slice(1)).get('reserva');
if(privateToken){
 history.replaceState(null,'',location.pathname);
 const consult=()=>{
  const version=detailsVersion;
  $('#booking').innerHTML='<div class="card" role="status">Consultando agendamento…</div>';
  reservationApi('consultar',privateToken).then(a=>{remember(privateToken);if(version===detailsVersion)showReservation(privateToken,a);}).catch(e=>{
   if(version!==detailsVersion)return;
   error(e);$('#booking').innerHTML='<button type="button" id="retryPage">Tentar novamente</button>';$('#retryPage').onclick=consult;rateControls();
  });
 };
 consult();
}

else api().then(data=>{if(initialVersion!==detailsVersion)return;salon=data;announceEstablishment(data.nome);document.documentElement.style.setProperty('--blue',data.cor);const rgb=data.cor.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);document.body.style.setProperty('--booking-accent-text',rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722>0.179?'#111':'#fff');$('#salon').innerHTML=`<div class="cover" id="cover"></div>${data.logo?`<img class="logo" alt="Logo do estabelecimento" src="${esc(data.logo)}">`:'<div class="logo image-fallback" aria-hidden="true">S</div>'}<div class="public-title"><h1>${esc(data.nome)}</h1><p class="muted">${esc(data.descricao)}</p><p>${esc([data.address,data.city,data.state].filter(Boolean).join(' - '))}</p>${data.instagram?`<a class="button" target="_blank" rel="noopener noreferrer" href="https://www.instagram.com/${encodeURIComponent(data.instagram)}/">Instagram</a>`:''}${data.telefone?`<a class="button" target="_blank" rel="noopener" href="https://wa.me/${data.telefone.replace(/\D/g,'').replace(/^(\d{10,11})$/,'55$1')}">Falar com o estabelecimento</a>`:''}</div>`;imageFallbacks($('#salon'));if(data.capa){const cover=$('#cover'),image=new Image();image.onload=()=>{cover.style.backgroundImage='url('+JSON.stringify(data.capa)+')';};image.src=data.capa;}services();}).catch(e=>{if(initialVersion!==detailsVersion)return;error(e);$('#booking').innerHTML='<button type="button" id="retryPage">Tentar novamente</button>';$('#retryPage').onclick=()=>location.reload();rateControls();});
$('#openMyBookings').onclick=()=>myBookings();
