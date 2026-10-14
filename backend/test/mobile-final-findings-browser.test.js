const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const express=require('express'),puppeteer=require('puppeteer');
const {financialSummary}=require('../services/finance');

test('Mobile final: contraste público, busca e fidelidade da prévia', {timeout:180000}, async t=>{
 const root=path.resolve(__dirname,'../public');
 const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));assert.ok(executablePath);
 const saved={nome:'Studio teste',slug:'final-test',descricao:'Cuidado e beleza.',telefone:'11999990000',cor:'#777777',address:'Rua das Flores, 123',city:'São Paulo',state:'SP',instagram:'studio_teste',businessType:'beauty_salon'};
 const initial=JSON.stringify(saved),mutations=[];
 const bookingDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date(Date.now()+86400000));
 const service={id:1,nome:'Corte',categoria:'Cabelo',descricao:'Cuidado personalizado.',preco:100,duracao:15,ativo:true};
 const professional={id:1,nome:'Ana',ativo:true,servicos:[1]};
 let color='#777777';
 const app=express();app.use(express.json());
 app.use('/api',(req,res)=>{
  if(req.path==='/chat/conversations/search'&&req.method==='POST')return res.json({conversations:[],nextCursor:null});
  if(req.method!=='GET'){mutations.push({path:req.path,body:req.body});return res.status(400).json({error:'Esta verificação não salva dados.'});}
  if(req.path==='/barbeiro/me')return res.json({id:1,barbearia_nome:saved.nome,valor_plano:65,acesso:{liberado:true,status:'subscription_active'}});
  if(req.path==='/studiofy/painel')return res.json({pagina:{...saved},servicos:[service],profissionais:[professional],agendamentos:[],lembretes:[],bloqueios:[],horarios:[],businessTypes:[{code:'beauty_salon',name:'Salão'}],financeiro:financialSummary([]),agenda:{hoje:bookingDate}});
  if(req.path==='/studiofy/public/final-test')return res.json({...saved,cor:color,servicos:[service],profissionais:[professional]});
  if(req.path.endsWith('/horarios'))return res.json(['08:00','08:15']);
  if(req.path==='/chat/conversations/unread')return res.json({messages:0});
  if(req.path.startsWith('/chat/conversations'))return res.json({conversations:[],nextCursor:null});
  res.json({});
 });
 app.get('/agendar/:slug',(_req,res)=>res.sendFile(path.join(root,'agendar.html')));app.use(express.static(root));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const errors=[];
 async function open(width,route='/studiofy.html'){
  const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));await p.setViewport({width,height:width===320?640:1000,isMobile:width<500,hasTouch:width<500});
  await p.setRequestInterception(true);p.on('request',r=>r.url().startsWith(base)||r.url().startsWith('data:')?r.continue():r.abort());
  await p.evaluateOnNewDocument(()=>localStorage.setItem('barbearia_auth_token','synthetic-final-test'));await p.goto(base+route);return p;
 }
 async function section(p,name){await p.waitForSelector('[data-section]');if(await p.$eval('#navigation',e=>e.hidden))await p.click('#menuToggle');await p.click(`[data-section="${name}"]`);}
 async function fits(p){assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'sem overflow horizontal');}
 function luminance(v){return v.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
 async function contrast(p,selector){const colors=await p.$eval(selector,e=>{const s=getComputedStyle(e);return [s.color,s.backgroundColor].map(c=>c.match(/[\d.]+/g).map(Number));});const [a,b]=colors.map(luminance);const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);assert.ok(ratio>=4.5,selector+' ratio='+ratio);return ratio;}
 async function shot(p,name,width){if(!process.env.STUDIOFY_VISUAL_ARTIFACTS)return;fs.mkdirSync(process.env.STUDIOFY_VISUAL_ARTIFACTS,{recursive:true});await p.screenshot({path:path.join(process.env.STUDIOFY_VISUAL_ARTIFACTS,`${name}-${width}.png`),fullPage:true});}
 for(const width of [320,360,390,430,768,1440]){
  await t.test(width+'px: contraste público em cores claras, escuras e na fronteira',async()=>{
   const p=await open(width,'/agendar/final-test');try{
    for(const shade of ['#777777','#767676','#757575','#747474','#000000','#ffffff','#1386ff','#ffee00']){
     color=shade;await p.reload();await p.waitForSelector('[data-service]');await contrast(p,'[data-service]');await fits(p);
     assert.equal(await p.evaluate(()=>document.documentElement.style.getPropertyValue('--blue')),shade,'cor configurada preservada');
     if(shade==='#777777'){
      assert.ok(Math.abs(await contrast(p,'[data-service]')-4.68949989000882)<.000001);
      await p.click('[data-service]');await p.waitForSelector('#date');await p.$eval('#date',(e,date)=>{e.value=date;e.dispatchEvent(new Event('change',{bubbles:true}));},bookingDate);
      await p.waitForSelector('[data-time]');await p.click('[data-time]');await contrast(p,'[data-time].selected');
      await p.type('#name','Cliente teste');await p.type('#phone','11999990000');await p.click('#review');await p.waitForSelector('#confirm');await contrast(p,'#confirm');await shot(p,'final-public',width);
     }
    }
   }finally{await p.close();}
  });
  await t.test(width+'px: busca de Conversas legível e layout preservado',async()=>{
   const p=await open(width);try{await section(p,'Conversas');await p.waitForSelector('.ci-search input');await fits(p);
    const size=await p.$eval('.ci-search input',e=>parseFloat(getComputedStyle(e).fontSize));assert.equal(size,width<=650?16:14);
    await p.type('.ci-search input','Ana');const request=p.waitForRequest(r=>r.url().includes('/chat/conversations/search')&&r.method()==='POST'&&JSON.parse(r.postData()||'{}').query==='Ana');
    await p.click('.ci-search button');const actual=await request;assert.equal(JSON.parse(actual.postData()).query,'Ana','busca preserva POST e corpo existente');
    await fits(p);await shot(p,'final-search',width);
   }finally{await p.close();}
  });
  await t.test(width+'px: endereço/Instagram presentes, vazios e extremos na prévia',async()=>{
   const p=await open(width);try{await section(p,'Minha página');await p.click('#previewButton');await p.waitForSelector('#preview:not([hidden])');
    assert.equal(await p.$eval('.preview-address',e=>e.textContent),'Rua das Flores, 123 - São Paulo - SP');
    assert.equal(await p.$eval('.preview-instagram',e=>e.href),'https://www.instagram.com/studio_teste/');assert.equal(await p.$eval('.preview-instagram',e=>e.rel),'noopener noreferrer');
    for(const sample of [
     {address:'EnderecoSemEspacos'.repeat(40),city:'Cidade'.repeat(20),state:'SP',instagram:'InstagramSemEspacos'.repeat(20)},
     {address:'Rua <&> "çã 💇',city:'Cidade',state:'SP',instagram:'nome<&>"'},
     {address:'',city:'',state:'',instagram:''},
     {address:' ',city:' ',state:' ',instagram:' '}
    ]){
     await p.evaluate(sample=>{for(const [name,value]of Object.entries(sample))document.querySelector(`[name="${name}"]`).value=value;},sample);await p.click('#previewButton');
     await p.waitForFunction(instagram=>Boolean(document.querySelector('.preview-instagram'))===Boolean(instagram.trim()),{},sample.instagram);
     const expected=[sample.address,sample.city,sample.state].map(x=>x.trim()).filter(Boolean).join(' - ');
     if(expected)assert.equal(await p.$eval('.preview-address',e=>e.textContent),expected);else assert.equal(await p.$('.preview-address'),null);
     if(sample.instagram.trim()){assert.equal(await p.$eval('.preview-instagram',e=>e.textContent),'Instagram · @'+sample.instagram.trim());assert.equal(await p.$eval('.preview-instagram',e=>e.href),'https://www.instagram.com/'+encodeURIComponent(sample.instagram.trim())+'/');}
     assert.equal(await p.$('#preview script'),null);await fits(p);
    }
    await p.evaluate(()=>{document.querySelector('[name=address]').value='EnderecoSemEspacos'.repeat(40);document.querySelector('[name=instagram]').value='InstagramSemEspacos'.repeat(20);});await p.click('#previewButton');await shot(p,'final-preview',width);
    assert.equal(JSON.stringify(saved),initial);assert.deepEqual(mutations,[],'prévia não grava dados');
   }finally{await p.close();}
  });
 }
 assert.deepEqual(errors,[]);assert.deepEqual(mutations,[]);
});
