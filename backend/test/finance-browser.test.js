const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { financialSummary } = require('../services/finance');
const { appointmentPermissions, localMoment } = require('../services/agenda');

test('Financeiro etapa 2: apresentação segura, responsividade e atualização', { timeout: 60000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, puppeteer.executablePath(),
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p => p && fs.existsSync(p));
  assert.ok(executablePath, 'Chromium necessário');
  const now = new Date('2026-10-15T15:00:00Z'), moment = localMoment(now);
  const booking = (id, data, preco, extra = {}) => ({ id, data, preco, hora: '09:00', status: 'concluido',
    nome_cliente: `Cliente ${id}`, servico_nome: 'Corte', studio_service_id: 1,
    profissional: 'Ana', telefone: '11999990000', ...extra });
  const valid = [booking(1,'2026-10-15',30.1),booking(2,'2026-10-15',20.2),
    booking(3,'2026-10-12',40,{studio_service_id:2,servico_nome:'Tratamento'}),
    booking(4,'2026-10-11',50,{studio_service_id:3,servico_nome:null}),
    booking(5,'2026-09-30',60)];
  const invalid = [booking(20,'2026-10-16',40),booking(21,'2026-10-15',900,{hora:'12:01'}),
    ...['confirmado','cancelado','falta'].map((status,i)=>booking(22+i,'2026-10-15',900,{status})),
    ...[null,-10,NaN,Infinity,1.005].map((preco,i)=>booking(30+i,'2026-10-15',preco)),
    booking(40,'2026-02-30',900),booking(41,'2026-10-15',900,{hora:'25:99'})];
  let rows = [...valid,...invalid], mode = 'ok', calls = 0, held = [];
  const app = express();
  app.get('/api/barbeiro/me', (_req,res)=>res.json({id:1,barbearia_nome:'Studio teste',
    acesso:{liberado:true,status:'subscription_active'}}));
  const payload = () => ({pagina:{slug:'studio-test'},agenda:{hoje:moment.date},
    agendamentos:rows.map(a=>({...a,...appointmentPermissions(a,moment)})),servicos:[],profissionais:[],
    bloqueios:[],lembretes:[],financeiro:financialSummary(rows,now)});
  app.get('/api/studiofy/painel', (_req,res)=>{
    calls++;
    if(mode==='error') return res.status(500).json({error:'Falha temporária.'});
    if(mode==='hold') { held.push({res,data:payload()}); return; }
    if(mode==='missing') return res.json({...payload(),financeiro:undefined});
    res.json(payload());
  });
  app.use(express.static(path.resolve(__dirname,'../public')));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const browser = await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const page = await browser.newPage(), errors = [];
  page.on('pageerror',error=>errors.push(error.message));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.setRequestInterception(true);
  page.on('request',req=>req.url().includes('/api/chat') || !req.url().startsWith(base)
    ? req.respond({status:200,contentType:'application/json',body:'{}'}) : req.continue());
  await page.evaluateOnNewDocument(()=>{
    localStorage.setItem('barbearia_auth_token','test-token');
    const originalTimeout=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>originalTimeout(fn,ms===20000 && window.fastFinanceTimeout?100:ms,...args);
  });
  await page.emulateTimezone('Pacific/Kiritimati');
  await page.setViewport({width:1440,height:1000});
  await page.goto(base+'/studiofy.html');
  await page.waitForSelector('#dashboardStatus[data-state=ready]');
  await page.click('[data-section="Financeiro"]');
  const value = key => page.$eval(`[data-finance="${key}"] .stat`,el=>el.textContent);
  const refresh = async () => { await page.evaluate(()=>action(refresh)); };

  await t.test('três cards, valores e quantidades de hoje/semana/mês; total compacto', async()=>{
    assert.equal(await page.$$('.finance-metrics .metric').then(els=>els.length),3);
    for(const [key,amount,count] of [['hoje','50,30',2],['semana','90,30',3],['mes','140,30',4]]){
      assert.ok((await value(key)).includes(amount));
      assert.match(await page.$eval(`[data-finance="${key}"] .finance-count`,el=>el.textContent),new RegExp(`^${count} atendimento`));
    }
    assert.equal(await value('total'),'5');
    assert.match(await page.$eval('[data-finance=total]',el=>el.textContent),/200,30/);
    assert.match(await page.$eval('[data-finance=semana]',el=>el.textContent),/12\/10\/2026.*segunda-feira/);
  });
  await t.test('ranking por quantidade e receita histórica; legado sem nome', async()=>{
    const data=await page.$$eval('#financeServices tbody tr',els=>els.map(el=>el.textContent));
    assert.match(data[0],/Corte3.*110,30/);
    assert.match(data[1],/Serviço não identificado1.*50,00/);
    assert.match(data[2],/Tratamento1.*40,00/);
  });
  await t.test('histórico ordenado, dados úteis e status; inválidos e IDs não aparecem', async()=>{
    const history=await page.$$eval('#financeHistory tbody tr',els=>els.map(el=>el.textContent));
    assert.equal(history.length,5);
    assert.match(history[0],/15\/10\/2026.*09:00.*Cliente 2.*Corte.*Ana.*20,20.*Concluído/);
    assert.match(history[3],/Serviço não identificado/);
    assert.doesNotMatch(history.join(' '),/Cliente (2[0-4]|3[0-4]|4[01])\b/);
    assert.equal(await page.$('#financeHistory [data-id]'),null);
    assert.doesNotMatch(await page.$eval('#financeHistory thead',el=>el.textContent),/ID|Telefone/);
  });
  await t.test('mesma receita no Dashboard, Financeiro e Relatórios sem recalcular', async()=>{
    await page.click('[data-section="Dashboard"]');
    assert.match(await page.$eval('[data-dashboard=revenue-today] .stat',el=>el.textContent),/50,30/);
    assert.match(await page.$eval('[data-dashboard=revenue-month] .stat',el=>el.textContent),/140,30/);
    await page.click('[data-section="Relatórios"]');
    assert.equal(await page.$$eval('#financeServices tbody tr',els=>els.length),3);
    assert.match(await page.$eval('#financeServices',el=>el.textContent),/110,30/);
    await page.click('[data-section="Financeiro"]');
  });
  await t.test('vazios por período, serviços e histórico; zero real sem placeholders', async()=>{
    rows=[];await refresh();
    for(const key of ['hoje','semana','mes']){
      assert.match(await value(key),/0,00/);
      assert.match(await page.$eval(`[data-finance="${key}"]`,el=>el.textContent),/0 atendimento.*Nenhum atendimento concluído neste período/s);
    }
    assert.match(await page.$eval('#financeServices',el=>el.textContent),/Nenhum serviço realizado/);
    assert.match(await page.$eval('#financeHistory',el=>el.textContent),/Nenhum registro financeiro/);
    rows=[booking(1,'2026-09-30',0)];await refresh();
    assert.equal(await page.$$('.finance-period-empty').then(els=>els.length),3);
    rows=[booking(1,'2026-10-15',0)];await refresh();
    assert.equal(await page.$$('.finance-period-empty').then(els=>els.length),0,'Preço zero é atendimento válido');
  });
  for(const width of [1440,390,320]){
    await t.test(`${width}px: valores grandes e nomes longos sem overflow; tabelas rolam internamente`,async()=>{
      await page.setViewport({width,height:1000});
      for(const amount of [0,999.99,10000,100000,1000000]){
        rows=[booking(1,'2026-10-15',amount,{servico_nome:'Serviço '+('NomeLongoSemEspaços'.repeat(25)),
          profissional:'Profissional '+('NomeLongoSemEspaços'.repeat(25)),nome_cliente:'Cliente '+('NomeLongoSemEspaços'.repeat(25))})];
        await refresh();
        assert.ok((await value('hoje')).includes(amount.toLocaleString('pt-BR',{minimumFractionDigits:2})));
        const layout=await page.evaluate(()=>({document:document.documentElement.scrollWidth,width:innerWidth,
          cards:[...document.querySelectorAll('.finance-metrics .metric')].map(el=>({width:el.clientWidth,scroll:el.scrollWidth})),
          tables:[...document.querySelectorAll('.finance-view .table-wrap')].map(el=>({width:el.clientWidth,scroll:el.scrollWidth}))}));
        assert.ok(layout.document<=layout.width,`Documento ${layout.document} > ${width}, valor ${amount}`);
        assert.ok(layout.cards.every(card=>card.scroll<=card.width),`Card transborda: ${amount}`);
        if(width<600)assert.ok(layout.tables.every(table=>table.scroll>table.width),'Rolagem restrita às tabelas');
      }
      const artifacts=path.resolve(__dirname,'../../.tmp/finance-stage2');fs.mkdirSync(artifacts,{recursive:true});
      await page.screenshot({path:path.join(artifacts,`finance-${width}.png`),fullPage:true});
      await page.click('[data-section="Relatórios"]');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.click('[data-section="Financeiro"]');
    });
  }
  await t.test('nomes são escapados e profissional ausente tem indicação neutra',async()=>{
    rows=[booking(1,'2026-10-15',10,{servico_nome:'<img src=x onerror=alert(1)>',profissional:null})];
    await refresh();assert.equal(await page.$('.finance-view img'),null);
    assert.match(await page.$eval('#financeHistory',el=>el.textContent),/Profissional não informado/);
  });
  await t.test('loading e requisições duplicadas compartilham uma consulta',async()=>{
    mode='hold';const before=calls;
    await page.evaluate(()=>{window.pendingFinanceRefresh=Promise.all([action(refresh),action(refresh),action(refresh)]);});
    await page.waitForSelector('#dashboardStatus[data-state=loading]');
    await page.waitForFunction(()=>document.querySelector('#view').getAttribute('aria-busy')==='true');
    await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,before+1);
    assert.match(await page.$eval('#dashboardStatus',el=>el.textContent),/Atualizando dados/);
    mode='ok';held.shift().res.json(payload());await page.evaluate(()=>window.pendingFinanceRefresh);
    assert.equal(await page.$eval('#view',el=>el.getAttribute('aria-busy')),'false');
  });
  await t.test('erro mantém dados, avisa desatualização e retry recupera',async()=>{
    mode='error';const old=await value('hoje');await refresh();
    assert.equal(await value('hoje'),old);
    assert.match(await page.$eval('#dashboardStatus',el=>el.textContent),/desatualizados/);
    mode='ok';await page.click('#retryDashboard');await page.waitForSelector('#dashboardStatus[data-state=ready]');
  });
  await t.test('timeout encerra loading e resposta antiga não sobrescreve retry',async()=>{
    mode='hold';await page.evaluate(()=>{window.fastFinanceTimeout=true;});await refresh();
    await page.waitForSelector('#dashboardStatus[data-state=error]');
    assert.match(await page.$eval('#message',el=>el.textContent),/demorou para responder/);
    const oldResponse=held.shift();rows=[booking(100,'2026-10-15',77)];mode='ok';
    await page.evaluate(()=>{window.fastFinanceTimeout=false;});await page.click('#retryDashboard');
    await page.waitForSelector('#dashboardStatus[data-state=ready]');assert.match(await value('hoje'),/77,00/);
    oldResponse.res.json(oldResponse.data);
    await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,50)));
    assert.match(await value('hoje'),/77,00/);
  });
  await t.test('resposta de refresh respeita a seção atual após navegação',async()=>{
    mode='hold';await page.evaluate(()=>{window.pendingFinanceRefresh=action(refresh);});
    await page.waitForSelector('#dashboardStatus[data-state=loading]');
    await page.click('[data-section="Relatórios"]');mode='ok';held.shift().res.json(payload());
    await page.evaluate(()=>window.pendingFinanceRefresh);
    assert.equal(await page.$eval('#title',el=>el.textContent),'Relatórios');assert.equal(await page.$('.finance-metrics'),null);
    await page.click('[data-section="Financeiro"]');
  });
  await t.test('resumo ausente tem erro e tentativa novamente, sem inventar zeros',async()=>{
    mode='missing';await refresh();assert.equal(await page.$('.finance-metrics'),null);
    assert.match(await page.$eval('#view',el=>el.textContent),/Financeiro indisponível/);
    mode='ok';await page.click('#refreshFinance');await page.waitForSelector('.finance-metrics');
  });
  await t.test('primeiro carregamento tem erro finito e retry sem dados fabricados',async()=>{
    mode='error';await page.reload();await page.waitForSelector('#dashboardStatus[data-state=error]');
    assert.equal(await page.$('.finance-metrics'),null);
    assert.match(await page.$eval('#dashboardStatus',el=>el.textContent),/Não foi possível carregar/);
    mode='ok';await page.click('#retryDashboard');await page.waitForSelector('#dashboardStatus[data-state=ready]');
    await page.click('[data-section="Financeiro"]');assert.match(await value('hoje'),/77,00/);
  });
  assert.deepEqual(errors,[]);
});
