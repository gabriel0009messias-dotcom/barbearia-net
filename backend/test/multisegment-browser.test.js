const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const executablePath=[process.env.CHROME_PATH,puppeteer.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&fs.existsSync(p));

test('página pública móvel mostra identidade e serviços de quatro segmentos', {skip:!executablePath},async t=>{
 const fixtures=[['barbershop','Corte','João'],['nails','Manicure','Ana'],['eyebrows','Design de sobrancelha','Carla'],['massage','Massagem relaxante','Lucas']];
 const app=express();
 app.use(express.json());
 let savedProfile,savedService;
 const panel={pagina:{nome:'Studio Bella',slug:'bella',cor:'#2878ff',businessType:'nails',city:'Salvador',state:'BA',address:'Rua A',instagram:'studio.bella'},businessTypes:[{code:'nails',name:'Unhas/Manicure'},{code:'massage',name:'Massagem'}],servicos:[{id:1,nome:'Manicure',categoria:'Unhas',preco:40,duracao:45,ativo:true}],profissionais:[],agendamentos:[],bloqueios:[],lembretes:[]};
 app.get('/api/barbeiro/me',(_req,res)=>res.json({id:1,barbearia_nome:'Studio',acesso:{liberado:true,status:'subscription_active'}}));
 app.get('/api/studiofy/painel',(_req,res)=>res.json(panel));
 app.put('/api/studiofy/pagina',(req,res)=>{savedProfile=req.body;Object.assign(panel.pagina,req.body);res.json({ok:true});});
 app.put('/api/studiofy/servicos/1',(req,res)=>{savedService=req.body;Object.assign(panel.servicos[0],req.body);res.json({ok:true});});
 app.get('/api/studiofy/public/:slug',(req,res)=>{
  const [slug,service,professional]=fixtures.find(x=>x[0]===req.params.slug);
  res.json({nome:'Studio '+slug,slug,cor:'#2878ff',descricao:'Atendimento personalizado',city:'Salvador',state:'BA',address:'Rua das Flores, 10',instagram:'studio.bella',servicos:[{id:1,nome:service,categoria:'Cuidados',descricao:'Descrição livre',preco:40,duracao:45}],profissionais:[{id:1,nome:professional,servicos:[1]}]});
 });
 app.get('/agendar/:slug',(_req,res)=>res.sendFile(path.resolve(__dirname,'../public/agendar.html')));
 app.use(express.static(path.resolve(__dirname,'../public')));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox']});
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 for(const [slug,service,professional] of fixtures){
  await page.goto(`http://127.0.0.1:${server.address().port}/agendar/${slug}`);await page.waitForSelector('[data-service]');
  const content=await page.$eval('body',el=>el.textContent);
  assert.ok(content.includes(service));assert.match(content,/Salvador - BA/);assert.match(content,/Rua das Flores/);assert.match(content,/Cuidados/);
  assert.doesNotMatch(content,/Escolha seu barbeiro|Serviços da barbearia|nosso salão/i);
  assert.equal(await page.$eval('a[href*="instagram.com"]',el=>el.href),'https://www.instagram.com/studio.bella/');
  await page.click('[data-service]');assert.equal(await page.$eval('#professional',el=>el.selectedOptions[0].textContent),professional);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 }
 await t.test('editor preserva perfil e envia categoria do serviço',async()=>{
  await page.evaluate(()=>localStorage.setItem('barbearia_auth_token','test-only'));
  await page.goto(`http://127.0.0.1:${server.address().port}/studiofy.html`);await page.waitForSelector('[data-section="Minha página"]');
  await page.click('[data-section="Minha página"]');await page.waitForSelector('[name=businessType]');
  assert.equal(await page.$eval('[name=city]',el=>el.value),'Salvador');
  await page.select('[name=businessType]','massage');
  await page.click('#editor [type=submit]');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('salvas'));
  assert.equal(savedProfile.businessType,'massage');assert.equal(savedProfile.city,'Salvador');assert.equal(savedProfile.instagram,'studio.bella');
  await page.click('[data-section="Meus serviços"]');await page.waitForSelector('[data-edit-service]');await page.click('[data-edit-service]');
  assert.equal(await page.$eval('[name=categoria]',el=>el.value),'Unhas');
  await page.$eval('[name=categoria]',el=>{el.value='Cuidados';});await page.click('#editor [type=submit]');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('salvas'));
  assert.equal(savedService.categoria,'Cuidados');assert.equal(savedService.duracao,45);
 });
 assert.deepEqual(errors,[]);
});
