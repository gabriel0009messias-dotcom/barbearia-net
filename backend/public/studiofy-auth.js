// Presentation only: no fetch, API clients, credentials, storage or real messages.
(() => {
 const host=document.querySelector('[data-whatsapp-demo]');
 if(!host)return;
 const segments=[['💇','Salão','Studio Bella'],['💅','Unhas','Studio Ana'],['✨','Sobrancelhas','Studio Olhar'],['💆','Massagem','Espaço Sereno'],['💈','Barbearia','Studio Corte']];
 host.innerHTML=`<div class="demo-heading"><span class="demo-kicker">CONEXÕES QUE VIRAM AGENDAMENTOS</span><h2>Seu atendimento<br>começa no <span>WhatsApp.</span></h2><p>Receba clientes, compartilhe seu agendamento e envie lembretes automaticamente com o Studiofy.</p></div>
 <div class="demo-segments" role="group" aria-label="Escolha um segmento para a demonstração">${segments.map(([emoji,label],i)=>`<button type="button" data-segment="${i}" aria-pressed="${i===0}">${emoji} ${label}</button>`).join('')}</div>
 <div class="demo-stage"><div class="demo-orbit" aria-hidden="true"></div><div class="demo-phone" aria-label="Conversa fictícia de agendamento">
 <div class="demo-statusbar" aria-hidden="true"><span>9:41</span><span>▂▃▅ ▰</span></div>
 <div class="demo-chat-header"><span aria-hidden="true">‹</span><span class="demo-avatar" aria-hidden="true">SB</span><div><strong class="demo-chat-name">Studio Bella</strong><span class="demo-chat-state">online</span></div><div class="demo-chat-icons" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 8l7-4v16l-7-4M3 6h11v12H3z"/></svg><svg viewBox="0 0 24 24"><path d="M4 3l5 2-2 5 7 7 5-2 2 5c-7 5-21-9-17-17z"/></svg></div></div>
 <div class="demo-chat"><span class="demo-date">Hoje · conversa ilustrativa</span>
 <div class="demo-message outgoing" data-message>Oi, quero marcar um horário.<small>09:41 ✓✓</small></div>
 <div class="demo-message" data-message>Olá! 👋 Seja bem-vindo ao <strong data-studio-name>Studio Bella</strong>.<small>09:41</small></div>
 <div class="demo-message" data-message>Você pode escolher seu serviço, profissional e horário disponível pelo nosso agendamento online.<button type="button" class="demo-booking-link" tabindex="-1">Agendar horário ↗</button><small>09:42</small></div>
 <div class="demo-message" data-message>Pronto! Seu horário foi agendado. ✅<small>09:43</small></div>
 <div class="demo-message" data-message>Olá, Ana! Passando para lembrar que seu horário é hoje às 15:30. 😊<small>Lembrete automático · 15:10</small></div>
 <div class="demo-typing" aria-hidden="true"><i></i><i></i><i></i></div></div>
 <div class="demo-compose" aria-hidden="true"><span>⊕</span><span>Mensagem</span><span>♩</span></div></div>
 <div class="demo-floating" aria-hidden="true"><span class="demo-floating-icon">✓</span><div><strong>Um horário. Tudo certo.</strong><small>Na agenda e na memória do cliente.</small></div></div></div>
 <div class="demo-benefits"><span>Agendamento online</span><span>WhatsApp integrado</span><span>Lembretes automáticos</span><span>Menos horários esquecidos</span></div>
 <div class="demo-controls"><span>Simulação visual · nenhuma mensagem é enviada</span><button type="button" data-demo-control>Pausar</button></div>`;
 const messages=[...host.querySelectorAll('[data-message]')],typing=host.querySelector('.demo-typing'),status=host.querySelector('.demo-chat-state'),control=host.querySelector('[data-demo-control]'),link=host.querySelector('.demo-booking-link');
 const reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
 let timers=[],playing=false;
 function clear(){timers.forEach(clearTimeout);timers=[];typing.classList.remove('is-visible');status.textContent='online';playing=false;}
 function finish(){clear();messages.forEach(m=>m.classList.add('is-visible'));link.tabIndex=0;control.textContent='Rever';}
 function later(fn,delay){timers.push(setTimeout(fn,delay));}
 function play(){
  clear();if(reduced.matches){finish();return;}
  playing=true;control.textContent='Pausar';link.tabIndex=-1;
  messages.forEach(m=>m.classList.remove('is-visible'));
  later(()=>messages[0].classList.add('is-visible'),350);
  [1300,3600,6400,8700].forEach((delay,i)=>{
   later(()=>{typing.classList.add('is-visible');status.textContent='digitando…';},delay);
   later(()=>{typing.classList.remove('is-visible');status.textContent='online';messages[i+1].classList.add('is-visible');if(i===1)link.tabIndex=0;},delay+1100);
  });
  later(finish,10300);
 }
 host.querySelectorAll('[data-segment]').forEach(button=>button.addEventListener('click',()=>{
  const selected=segments[Number(button.dataset.segment)];
  host.querySelectorAll('[data-segment]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  host.querySelector('.demo-chat-name').textContent=selected[2];host.querySelector('[data-studio-name]').textContent=selected[2];
  host.querySelector('.demo-avatar').textContent=selected[2].split(' ').map(s=>s[0]).join('');play();
 }));
 control.addEventListener('click',()=>{if(playing){clear();control.textContent='Rever';}else play();});
 link.addEventListener('click',finish);
 reduced.addEventListener('change',finish);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)finish();});
 window.addEventListener('pagehide',clear);
 // On mobile the demo starts only when the user reaches it below the form.
 if('IntersectionObserver' in window){
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){observer.disconnect();play();}},{threshold:.2});observer.observe(host);
 }else play();
})();
