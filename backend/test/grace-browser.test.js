const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));
test('Etapa 3: estados do painel e Controle Interno no navegador',{skip:!executablePath,timeout:60000},async t=>{
  const app=express();app.use(express.json());let access,operational=0;
  app.get('/api/barbeiro/me',(_req,res)=>res.json({id:17,barbearia_nome:'Fixture',acesso:access}));
  app.get('/api/studiofy/painel',(_req,res)=>{operational++;res.json({pagina:{nome:'Fixture',slug:'fixture'},agendamentos:[],servicos:[],profissionais:[],bloqueios:[],lembretes:[]});});
  app.get('/api/publico/assinatura-config',(_req,res)=>res.json({plan:{amountCents:6500,durationDays:30}}));
  app.post('/api/admin/login',(_req,res)=>res.json({token:'synthetic-token'}));
  app.get('/api/admin/assinatura-config',(_req,res)=>res.json({}));
  app.get('/api/admin/assinaturas',(_req,res)=>{
    const row={id:17,barbearia_nome:'Fixture',status:access.liberado?'ativo':'bloqueado',bloqueio_admin:access.status==='admin_blocked',acesso:access};
    res.json({assinaturas:[row],pendentes:[{...row,id:18,status:'aguardando_pagamento'}]});
  });
  app.use(express.static(path.resolve(__dirname,'../public')));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const page=await browser.newPage();await page.emulateTimezone('America/New_York');
  await page.evaluateOnNewDocument(()=>localStorage.setItem('barbearia_auth_token','synthetic-owner'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));const base=`http://127.0.0.1:${server.address().port}`;
  const cases=[['trial_active',true,'Teste gratis ativo.','Trial ativo'],['subscription_active',true,'Assinatura ativa.','Assinatura ativa'],['grace_period',true,'Sua assinatura esta em tolerancia.','Tolerância'],['payment_required',false,'Sua assinatura expirou. Seus dados continuam salvos.','Assinatura expirada'],['admin_blocked',false,'Bloqueado pelo administrador.','Bloqueada administrativamente'],['manual_access',true,'Seu acesso temporario esta liberado.','Liberação manual']];
  for(const [status,liberado,mensagem,label] of cases)await t.test(status,async()=>{
    access={status,liberado,mensagem,motivo:status==='payment_required'?'subscription_expired':status,trial:{endsAt:'2026-10-14T18:30:00Z',daysRemaining:4},toleranciaAte:'2026-10-14T18:30:00Z',toleranciaRestanteMs:60001};
    const before=operational;await page.goto(base+'/studiofy.html');await page.waitForSelector(liberado?'[data-section="Dashboard"]':'#subscribe');
    const banner=await page.$eval('#trialBanner',e=>({hidden:e.hidden,text:e.textContent}));
    if(status==='subscription_active')assert.equal(banner.hidden,true);
    else if(status==='grace_period'){assert.equal(banner.hidden,false);assert.match(banner.text,/Tolerância.*2 minuto\(s\).*15:30/);assert.doesNotMatch(banner.text,/expir/i);}
    else if(status==='trial_active')assert.match(banner.text,/4 dia\(s\) restantes/);
    else assert.equal(banner.text,mensagem);
    if(!liberado)assert.equal(operational,before,'Nenhuma chamada operacional com acesso negado');
    await page.goto(base+'/controle-interno.html');await page.type('#adminEmailInput','synthetic@example.test');await page.type('#adminSenhaInput','synthetic-password');await page.click('#adminLoginForm button');await page.waitForSelector('#adminPendentesBody .grant-days');
    assert.match(await page.$eval('#adminAssinaturasBody tr',e=>e.textContent),new RegExp(label));
    assert.equal(await page.$eval('#adminPendentesBody tr td:nth-child(6)',e=>e.textContent),label);
  });
  assert.deepEqual(errors,[]);
});
