// Product tour: booking and conversation state are local and fictitious.
(() => {
  document.body.classList.add('js');
  const toggle=document.querySelector('.menu-toggle'),nav=document.querySelector('#site-nav');
  toggle.hidden=false;
  function closeMenu(){nav.classList.remove('is-open');toggle.setAttribute('aria-expanded','false');}
  toggle.addEventListener('click',()=>{const open=nav.classList.toggle('is-open');toggle.setAttribute('aria-expanded',String(open));});
  nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&nav.classList.contains('is-open')){closeMenu();toggle.focus();}});

  // Customize only the landing's illustration; Login/Cadastro keep their original demo.
  const phone=document.querySelector('.hero-showcase');
  phone.querySelector('.demo-kicker').textContent='WHATSAPP + AGENDA, EM SINTONIA';
  const phoneMessages=phone.querySelectorAll('[data-message]');
  phoneMessages[0].firstChild.textContent='Oi, tem horário amanhã?';
  phoneMessages[2].firstChild.textContent='Claro! 😊 Você pode escolher o serviço e consultar os horários disponíveis.';
  phoneMessages[3].firstChild.textContent='Agendamento confirmado! ✅';
  phoneMessages[4].firstChild.textContent='Olá, Ana! Lembrando que seu horário é hoje às 15:30.';

  const services=[{name:'Manicure',duration:45,price:40,symbol:'💅'},{name:'Design de sobrancelhas',duration:30,price:35,symbol:'✨'},{name:'Massagem relaxante',duration:60,price:100,symbol:'💆'}];
  const people=['Júlia','Camila','Alex'],dates=['Amanhã','Depois de amanhã'],times=['9h','10h30','11h','15h30'];
  const content=document.querySelector('#booking-demo-content'),progress=[...document.querySelectorAll('.booking-progress li')];
  let step=0,selection={};
  const money=value=>value.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  function syncDelivery(){
    const confirmed=step===5,service=confirmed?selection.service.name:'Manicure',person=confirmed?selection.person:'Júlia';
    const date=confirmed?selection.date.toLowerCase():'amanhã';
    const [hour,minute='00']=(confirmed?selection.time:'15h30').split('h');
    const time=hour.padStart(2,'0')+':'+(minute||'00');
    const reminderMinutes=Number(hour)*60+Number(minute||0)-20;
    const reminderTime=String(Math.floor(reminderMinutes/60)).padStart(2,'0')+':'+String(reminderMinutes%60).padStart(2,'0');
    const detail=`${service} · ${person} · ${date} às ${time}`;
    document.querySelector('#demo-chosen-time').textContent=detail;
    document.querySelector('#demo-reminder').textContent=`Olá, Ana! Lembrando que seu horário é hoje às ${time}.`;
    document.querySelector('.reminder-bubble small').textContent=`Lembrete · exemplo, às ${reminderTime}`;
    document.querySelector('#demo-owner-details').textContent='Ana · '+detail;
    document.querySelector('#demo-owner-status').textContent=confirmed?'Agendamento recebido na demonstração':'Novo agendamento recebido';
    document.querySelector('#demo-delivery-details').textContent=`Confirmação do horário e lembrete às ${reminderTime}, no dia do atendimento. Somente demonstração.`;
    document.querySelector('.delivery-preview').classList.toggle('is-confirmed',confirmed);
  }
  function option(index,title,note='',symbol='',suffix='Escolher →'){
    const button=document.createElement('button');button.type='button';button.className='demo-option';button.dataset.choice=index;
    if(symbol){const icon=document.createElement('span');icon.className='option-symbol';icon.textContent=symbol;button.append(icon);}
    const text=document.createElement('span'),strong=document.createElement('strong');strong.textContent=title;text.append(strong);
    if(note){const small=document.createElement('small');small.textContent=note;text.append(small);}button.append(text);
    if(suffix){const right=document.createElement('span');right.className='option-suffix';right.textContent=suffix;button.append(right);}return button;
  }
  function render(focus=false){
    syncDelivery();
    progress.forEach((el,i)=>{if(i===Math.min(step,4))el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
    const titles=['Escolha seu cuidado','Com quem você quer agendar?','Qual dia fica melhor?','Escolha seu horário','Tudo pronto para conferir','Pronto! Você conheceu o fluxo.'];
    const notes=['Serviços fictícios para explorar a experiência.','Profissionais ilustrativos desta demonstração.','Datas relativas, apenas para demonstração.','Disponibilidade fictícia. Nenhuma consulta à agenda real.','Confira o exemplo antes de simular a confirmação.','Esta foi uma simulação. Nenhuma reserva ou mensagem foi criada.'];
    content.replaceChildren();const h=document.createElement('h4'),p=document.createElement('p');h.textContent=titles[step];p.textContent=notes[step];content.append(h,p);
    const options=document.createElement('div');options.className='demo-options';content.append(options);
    if(step===0)services.forEach((s,i)=>options.append(option(i,s.name,`${s.duration} min · ${money(s.price)}`,s.symbol)));
    if(step===1)people.forEach((person,i)=>options.append(option(i,person,'Profissional do exemplo','◇')));
    if(step===2)dates.forEach((date,i)=>options.append(option(i,date,'Escolha ilustrativa','▦')));
    if(step===3){options.classList.add('demo-time-options');times.forEach((time,i)=>options.append(option(i,time,'','','')));}
    if(step>=4){
      const summary=document.createElement('div');summary.className='demo-summary';const name=document.createElement('strong');name.textContent=selection.service.name;
      const detail=document.createElement('span');detail.textContent=`${selection.person} · ${selection.date} · ${selection.time} · ${selection.service.duration} min · ${money(selection.service.price)}`;summary.append(name,detail);options.append(summary);
      const button=document.createElement('button');button.type='button';button.className='button';button.dataset.action=step===4?'confirm':'restart';button.textContent=step===4?'Confirmar demonstração →':'Experimentar outro serviço';options.append(button);
      if(step===5){const icon=document.createElement('span');icon.className='success-icon';icon.textContent='✓';icon.setAttribute('aria-hidden','true');content.prepend(icon);}
    }
    if(step>0&&step<5){const back=document.createElement('button');back.className='demo-back';back.type='button';back.dataset.action='back';back.textContent='← Voltar';content.append(back);}
    if(focus)content.focus({preventScroll:true});
  }
  content.addEventListener('click',event=>{
    const target=event.target.closest('button');if(!target)return;
    if(target.dataset.action==='back'){step--;render(true);return;}
    if(target.dataset.action==='restart'){step=0;selection={};render(true);return;}
    if(target.dataset.action==='confirm'){step=5;render(true);return;}
    if(target.dataset.choice!==undefined){const i=Number(target.dataset.choice);
      if(step===0)selection.service=services[i];if(step===1)selection.person=people[i];if(step===2)selection.date=dates[i];if(step===3)selection.time=times[i];step++;render(true);
    }
  });
  render();

  // The only network operation reads the existing public plan configuration.
  const price=document.querySelector('#home-plan-price'),period=document.querySelector('#home-plan-period');
  async function loadPlan(){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
    try{
      const response=await fetch('/api/publico/assinatura-config',{signal:controller.signal,cache:'no-store'});if(!response.ok)throw Error('Plan unavailable');
      const {plan}=await response.json();
      if(!plan||!Number.isSafeInteger(plan.amountCents)||plan.amountCents<=0||!Number.isInteger(plan.durationDays)||plan.durationDays<=0||plan.currency!=='BRL')throw Error('Invalid plan');
      document.querySelector('#home-plan-name').textContent=typeof plan.name==='string'?plan.name:'Plano Studiofy';price.textContent=money(plan.amountCents/100);period.textContent=`por ${plan.durationDays} dias · plano atual`;
    }catch{price.textContent='Consulte no cadastro';price.style.fontSize='28px';period.textContent='Não foi possível consultar o preço agora. Verifique as condições no cadastro antes de continuar.';}
    finally{clearTimeout(timeout);}
  }
  loadPlan();
})();
