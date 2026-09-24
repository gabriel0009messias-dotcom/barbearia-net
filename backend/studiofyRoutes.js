const {profileInput,saveProfile,publicProfile}=require('./services/establishment');
const express=require('express');
const rateLimit=require('express-rate-limit');
const {createPublicBookings}=require('./services/publicBookings');
const {createStudio,serviceInput,image,validateHours,validDate,time,text,fail,effectiveHours}=require('./services/studiofy');
module.exports=function studioRoutes(db,auth,access) {
 const router=express.Router();
 const wrap=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(e.code==='23505'?409:e.statusCode || 500).json({error:e.code==='23505'?'Horário ou link já utilizado.':e.statusCode?e.message:'Não foi possível concluir a operação.'});}};
 const tx=fn=>db.transaction(c=>fn(createStudio(c),c));
 const publicTenant=async slug=>{
  const a=await db.getAsync("SELECT * FROM assinaturas WHERE COALESCE(public_slug,'studio-' || id)=$1",[slug]);
  if(!a || !(await access(a)).liberado) fail('Página indisponível.',404);
  return a;
 };
  const page=a=>({...publicProfile(a),nome:a.barbearia_nome,descricao:a.page_description,telefone:a.telefone,slug:a.public_slug || 'studio-'+a.id,capa:a.cover_image,logo:a.logo_image,cor:a.page_color,antecedencia_cancelamento_minutos:a.cancellation_notice_minutes});
 router.use('/public',rateLimit({windowMs:60000,limit:90,validate:{trustProxy:false}}));
 router.use('/public',(_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
 router.post('/public/reservas/consultar',wrap(async(req,res)=>{
  res.json(await createPublicBookings(db).get(req.body.token));
 }));
 router.post('/public/reservas/cancelar',wrap(async(req,res)=>{
  if(req.body.confirmar!==true)fail('Confirme o cancelamento antes de continuar.');
  res.json(await db.transaction(c=>createPublicBookings(c).cancel(req.body.token)));
 }));
 router.get('/public/:slug',wrap(async(req,res)=>{
  const a=await publicTenant(req.params.slug);
  const data=await tx(async s=>{await s.ensure(a.id);return {servicos:(await s.services(a.id)).filter(x=>x.ativo),profissionais:(await s.professionals(a.id)).filter(x=>x.ativo)};});
  res.json({...page(a),...data});
 }));
 router.get('/public/:slug/horarios',wrap(async(req,res)=>{
  const a=await publicTenant(req.params.slug);
  res.json(await createStudio(db).times(a.id,req.query.data,req.query.servico_id,req.query.profissional_id));
 }));
 router.post('/public/:slug/agendamentos',wrap(async(req,res)=>{
  const a=await publicTenant(req.params.slug);
  res.status(201).json(await tx(async(s,c)=>{
   const booking=await s.book(a.id,req.body),publicBookings=createPublicBookings(c);
   const token=await publicBookings.issue(booking.id);
   return {token,agendamento:await publicBookings.get(token)};
  }));
 }));
 router.use(auth);
 router.put('/politica-cancelamento',wrap(async(req,res)=>{
  const minutes=req.body.antecedencia_minutos;
  if(!Number.isInteger(minutes) || minutes<0 || minutes>129600)fail('Informe de 0 a 129600 minutos de antecedência.');
  await db.transaction(c=>c.runAsync('UPDATE assinaturas SET cancellation_notice_minutes=$1 WHERE id=$2',[minutes,req.assinatura.id]));
  res.json({ok:true});
 }));
 router.get('/painel',wrap(async(req,res)=>{
  const id=req.assinatura.id;
  const result=await tx(async(s,c)=>{
   await s.ensure(id);
   const a=await c.getAsync('SELECT * FROM assinaturas WHERE id=$1',[id]);
   return {businessTypes:await c.allAsync('SELECT code,name FROM business_types WHERE active=true ORDER BY sort_order,name'),pagina:page(a),horarios:effectiveHours(a),servicos:await s.services(id),profissionais:await s.professionals(id),
    agendamentos:await c.allAsync('SELECT a.*,p.nome AS profissional FROM agendamentos a LEFT JOIN profissionais p ON p.id=a.profissional_id AND p.assinatura_id=a.assinatura_id WHERE a.assinatura_id=$1 ORDER BY a.data DESC,a.hora',[id]),
    bloqueios:await c.allAsync('SELECT * FROM bloqueios WHERE assinatura_id=$1 ORDER BY data,hora',[id]),
    lembretes:await c.allAsync('SELECT r.*,a.nome_cliente,a.data,a.hora FROM appointment_reminders r JOIN agendamentos a ON a.id=r.appointment_id AND a.assinatura_id=r.assinatura_id WHERE r.assinatura_id=$1 ORDER BY due_at DESC LIMIT 200',[id])};
  });
  res.json(result);
 }));
 router.post('/servicos',wrap(async(req,res)=>{
  const s=await serviceInput(req.body);
  const result=await tx(async(st,c)=>{
   await st.ensure(req.assinatura.id);
   const r=await c.runAsync('INSERT INTO servicos_assinatura (assinatura_id,nome,descricao,preco,duracao,foto,ativo,categoria) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[req.assinatura.id,s.nome,s.descricao,s.preco,s.duracao,s.foto,s.ativo,s.categoria??'']);
   const p=await st.professionals(req.assinatura.id);
   if(p.length===1) await c.runAsync('INSERT INTO profissional_servicos VALUES ($1,$2,$3)',[req.assinatura.id,p[0].id,r.lastID]);
   return {id:r.lastID};
  });res.status(201).json(result);
 }));
 router.put('/servicos/:id',wrap(async(req,res)=>{
  const s=await serviceInput(req.body);
  const r=await db.runAsync('UPDATE servicos_assinatura SET nome=$1,descricao=$2,preco=$3,duracao=$4,foto=$5,ativo=$6,categoria=COALESCE($9,categoria) WHERE id=$7 AND assinatura_id=$8',[s.nome,s.descricao,s.preco,s.duracao,s.foto,s.ativo,req.params.id,req.assinatura.id,s.categoria??null]);
  if(!r.changes)fail('Serviço não encontrado.',404);res.json({ok:true});
 }));
 router.delete('/servicos/:id',wrap(async(req,res)=>{
  const r=await db.runAsync('UPDATE servicos_assinatura SET ativo=false WHERE id=$1 AND assinatura_id=$2',[req.params.id,req.assinatura.id]);
  if(!r.changes)fail('Serviço não encontrado.',404);res.json({ok:true});
 }));
 async function professional(req,res) {
  const nome=text(req.body.nome),ids=req.body.servicos;
  if(!nome || !Array.isArray(ids) || !ids.every(Number.isSafeInteger) || new Set(ids).size!==ids.length || typeof req.body.ativo!=='boolean')fail('Profissional inválido.');
  const id=await tx(async(s,c)=>{
   const own=await s.services(req.assinatura.id);
   if(ids.some(id=>!own.some(x=>x.id===id)))fail('Serviço inválido.');
   let id=req.params.id;
   if(id){const r=await c.runAsync('UPDATE profissionais SET nome=$1,ativo=$2 WHERE id=$3 AND assinatura_id=$4',[nome,req.body.ativo,id,req.assinatura.id]);if(!r.changes)fail('Profissional não encontrado.',404);}
   else id=(await c.runAsync('INSERT INTO profissionais (assinatura_id,nome,ativo) VALUES ($1,$2,$3)',[req.assinatura.id,nome,req.body.ativo])).lastID;
   await c.runAsync('DELETE FROM profissional_servicos WHERE assinatura_id=$1 AND profissional_id=$2',[req.assinatura.id,id]);
   for(const service of ids)await c.runAsync('INSERT INTO profissional_servicos VALUES ($1,$2,$3)',[req.assinatura.id,id,service]);
   return id;
  });res.json({id});
 }
 router.post('/profissionais',wrap(professional));router.put('/profissionais/:id',wrap(professional));
 router.put('/pagina',wrap(async(req,res)=>{
  const b=req.body,nome=text(b.nome),descricao=text(b.descricao || '',1000),telefone=text(b.telefone || '',30),slug=text(b.slug,80);
  if(!nome || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !/^#[a-fA-F0-9]{6}$/.test(b.cor) || (telefone && !/^[+()\d\s-]{8,30}$/.test(telefone)))fail('Revise nome, link, telefone e cor.');
  if(/^studio-\d+$/.test(slug) && slug!=='studio-'+req.assinatura.id)fail('Este formato de link está reservado. Escolha outro nome.');
  const profile=await profileInput(db,b);
  const capa=await image(b.capa),logo=await image(b.logo);
  await db.transaction(async connection=>{
  await connection.runAsync('UPDATE assinaturas SET barbearia_nome=$1,page_description=$2,telefone=$3,public_slug=$4,page_color=$5,cover_image=$6,logo_image=$7 WHERE id=$8',[nome,descricao,telefone,slug,b.cor,capa,logo,req.assinatura.id]);
  await saveProfile(connection,req.assinatura.id,profile);
  });
  res.json({ok:true});
 }));
 router.put('/horarios',wrap(async(req,res)=>{const hours=validateHours(req.body.horarios);await db.runAsync('UPDATE assinaturas SET weekly_hours=$1 WHERE id=$2',[JSON.stringify(hours),req.assinatura.id]);res.json({ok:true});}));
 router.post('/bloqueios',wrap(async(req,res)=>{
  const b=req.body;if(!validDate(b.data) || (b.hora && (!time(b.hora) || !time(b.fim) || b.fim<=b.hora)))fail('Bloqueio inválido.');
  await tx(async(s,c)=>{
   if(b.profissional_id && !(await s.professionals(req.assinatura.id)).some(p=>p.id===Number(b.profissional_id)))fail('Profissional inválido.');
   await c.runAsync('INSERT INTO bloqueios (assinatura_id,data,hora,fim,profissional_id) VALUES ($1,$2,$3,$4,$5)',[req.assinatura.id,b.data,b.hora || null,b.hora?b.fim:null,b.profissional_id || null]);
  });res.status(201).json({ok:true});
 }));
 router.delete('/bloqueios/:id',wrap(async(req,res)=>{await db.runAsync('DELETE FROM bloqueios WHERE id=$1 AND assinatura_id=$2',[req.params.id,req.assinatura.id]);res.json({ok:true});}));
 router.get('/horarios',wrap(async(req,res)=>res.json(await createStudio(db).times(req.assinatura.id,req.query.data,req.query.servico_id,req.query.profissional_id,Number(req.query.excluir_id)||0))));
 router.post('/agendamentos',wrap(async(req,res)=>res.status(201).json(await tx(s=>s.book(req.assinatura.id,req.body)))));
 router.put('/agendamentos/:id',wrap(async(req,res)=>res.json(await tx(s=>s.book(req.assinatura.id,req.body,req.params.id)))));
 router.patch('/agendamentos/:id',wrap(async(req,res)=>{
  if(!['confirmado','cancelado','concluido','falta'].includes(req.body.status))fail('Status inválido.');
  await tx(async(s,c)=>{
   const a=await c.getAsync('SELECT * FROM agendamentos WHERE id=$1 AND assinatura_id=$2',[req.params.id,req.assinatura.id]);if(!a)fail('Agendamento não encontrado.',404);
   if(req.body.status==='confirmado' && a.status!=='confirmado') {
    if(!(await s.times(req.assinatura.id,a.data,a.studio_service_id,a.profissional_id,a.id)).includes(a.hora))fail('Horário indisponível.',409);
   }
   await c.runAsync('UPDATE agendamentos SET status=$1 WHERE id=$2 AND assinatura_id=$3',[req.body.status,req.params.id,req.assinatura.id]);
  });res.json({ok:true});
 }));
 return router;
};
