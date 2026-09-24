const sharp = require('sharp');
const { localNow, addDays } = require('./whatsapp/scheduling');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const text = (value, max = 100) => typeof value === 'string' && value.trim().length <= max ? value.trim() : fail('Texto inválido.');
const minute = value => { const [h,m] = value.split(':').map(Number); return h*60+m; };
const time = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const overlap = (a,b,c,d) => a < d && c < b;
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value; }
function effectiveHours(config) {
 if(config.weekly_hours) return config.weekly_hours;
 return Array.from({length:7},(_,day)=>String(config.dias_funcionamento).split(',').map(Number).includes(day)
  ? [[config.horario_abertura,config.horario_almoco_inicio],[config.horario_almoco_fim,config.horario_fechamento]].filter(p=>p.every(time) && p[0]<p[1]) : []);
}
async function image(value) {
 if (!value) return null;
 if (typeof value !== 'string' || value.length > 2800000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) fail('Use PNG, JPEG ou WebP de até 2 MB.');
 const bytes = Buffer.from(value.split(',')[1], 'base64');
 if (bytes.length > 2*1024*1024) fail('Imagem maior que 2 MB.');
 try {
  const result = await sharp(bytes, { limitInputPixels: 16000000 }).rotate().resize({ width:1600,height:1600,fit:'inside',withoutEnlargement:true }).webp({quality:80}).toBuffer();
  return `data:image/webp;base64,${result.toString('base64')}`;
 } catch { fail('Imagem inválida ou com resolução excessiva.'); }
}
async function serviceInput(body) {
 const nome=text(body.nome), descricao=text(body.descricao || '',1000), preco=Number(body.preco), duracao=Number(body.duracao);
 if (!nome || !Number.isFinite(preco) || preco<0 || preco>100000 || Math.abs(preco*100-Math.round(preco*100))>0.00001 || !Number.isInteger(duracao) || duracao<5 || duracao>720) fail('Informe nome, preço válido e duração entre 5 e 720 minutos.');
 if (body.ativo !== undefined && typeof body.ativo !== 'boolean') fail('Status inválido.');
 return { categoria:body.categoria===undefined?undefined:text(body.categoria,100),nome,descricao,preco,duracao,foto:await image(body.foto),ativo:body.ativo!==false };
}
function validateHours(hours) {
 if (!Array.isArray(hours) || hours.length!==7) fail('Configure os sete dias da semana.');
 return hours.map(periods=>{
  if (!Array.isArray(periods) || periods.length>4) fail('Horários inválidos.');
  let end=-1;
  return periods.map(p=>{ if (!Array.isArray(p) || p.length!==2 || !p.every(time) || minute(p[0])>=minute(p[1]) || minute(p[0])<end) fail('Intervalos inválidos ou sobrepostos.'); end=minute(p[1]);return p; });
 });
}
function createStudio(db, clock=()=>new Date()) {
 const services = tenant => db.allAsync('SELECT * FROM servicos_assinatura WHERE assinatura_id=$1 ORDER BY id',[tenant]);
 const professionals = tenant => db.allAsync(`SELECT p.*, COALESCE(json_agg(ps.servico_id) FILTER (WHERE ps.servico_id IS NOT NULL),'[]') AS servicos FROM profissionais p LEFT JOIN profissional_servicos ps ON ps.profissional_id=p.id AND ps.assinatura_id=p.assinatura_id WHERE p.assinatura_id=$1 GROUP BY p.id ORDER BY p.id`,[tenant]);
 async function ensure(tenant) {
  await db.runAsync("UPDATE assinaturas SET public_slug='studio-' || id WHERE id=$1 AND public_slug IS NULL",[tenant]);
  if (!(await professionals(tenant)).length) {
   const p=await db.runAsync('INSERT INTO profissionais (assinatura_id,nome) SELECT id,responsavel_nome FROM assinaturas WHERE id=$1',[tenant]);
   await db.runAsync('INSERT INTO profissional_servicos SELECT assinatura_id,$1,id FROM servicos_assinatura WHERE assinatura_id=$2 ON CONFLICT DO NOTHING',[p.lastID,tenant]);
  }
 }
 async function times(tenant,date,serviceId,professionalId,excludeId=0) {
  const now=localNow(clock());
  if (!validDate(date) || date<now.date || date>addDays(now.date,90)) return [];
  const s=await db.getAsync('SELECT * FROM servicos_assinatura WHERE id=$1 AND assinatura_id=$2 AND ativo=true',[serviceId,tenant]);
  const p=await db.getAsync('SELECT p.id FROM profissionais p JOIN profissional_servicos ps ON ps.profissional_id=p.id AND ps.assinatura_id=p.assinatura_id WHERE p.id=$1 AND p.assinatura_id=$2 AND p.ativo=true AND ps.servico_id=$3',[professionalId,tenant,serviceId]);
  if (!s || !p) return [];
  const config=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[tenant]);
  const day=new Date(date+'T12:00:00Z').getUTCDay();
  const hours=effectiveHours(config)[day];
  const taken=await db.allAsync("SELECT hora,duracao FROM agendamentos WHERE assinatura_id=$1 AND data=$2 AND status='confirmado' AND (profissional_id=$3 OR profissional_id IS NULL) AND id<>$4",[tenant,date,professionalId,excludeId]);
  const blocks=await db.allAsync('SELECT hora,fim FROM bloqueios WHERE assinatura_id=$1 AND data=$2 AND (profissional_id=$3 OR profissional_id IS NULL)',[tenant,date,professionalId]);
  const results=[];
  for (const [start,end] of hours) for(let m=minute(start);m+s.duracao<=minute(end);m+=5) {
   const label=`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
   if (date===now.date && label<=now.time) continue;
   if (taken.some(a=>overlap(m,m+s.duracao,minute(a.hora),minute(a.hora)+a.duracao))) continue;
   if (blocks.some(b=>!b.hora || overlap(m,m+s.duracao,minute(b.hora),b.fim?minute(b.fim):minute(b.hora)+30))) continue;
   results.push(label);
  }
  return results;
 }
 async function book(tenant,body,id=null) {
  if(id && !(await db.getAsync('SELECT id FROM agendamentos WHERE assinatura_id=$1 AND id=$2',[tenant,id]))) fail('Agendamento não encontrado.',404);
  const nome=text(body.nome_cliente), telefone=String(body.telefone || '').replace(/\D/g,'');
  if (nome.length<2 || !/^\d{10,15}$/.test(telefone)) fail('Informe nome e telefone válidos.');
  if (!(await times(tenant,body.data,body.servico_id,body.profissional_id,id || 0)).includes(body.hora)) fail('Horário indisponível. Escolha outro horário.',409);
  const s=await db.getAsync('SELECT * FROM servicos_assinatura WHERE assinatura_id=$1 AND id=$2',[tenant,body.servico_id]);
  const values=[tenant,nome,telefone.length<=11?'55'+telefone:telefone,s.nome,s.preco,body.data,body.hora,body.profissional_id,s.duracao,s.id];
  if(id) {
   const result=await db.runAsync("UPDATE agendamentos SET nome_cliente=$2,telefone=$3,servico_nome=$4,preco=$5,data=$6,hora=$7,profissional_id=$8,duracao=$9,studio_service_id=$10,status='confirmado' WHERE assinatura_id=$1 AND id=$11",[...values,id]);
   if(!result.changes) fail('Agendamento não encontrado.',404);
   return {id};
  }
  const result=await db.runAsync("INSERT INTO agendamentos (assinatura_id,nome_cliente,telefone,servico_nome,preco,data,hora,profissional_id,duracao,studio_service_id,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmado')",values);
  return {id:result.lastID};
 }
 return {services,professionals,ensure,times,book};
}
module.exports={createStudio,serviceInput,image,validateHours,validDate,time,text,fail,effectiveHours};
