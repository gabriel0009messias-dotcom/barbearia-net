const crypto=require('node:crypto');
const {fail}=require('./studiofy');
const {transitionAppointment}=require('./agenda');
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
function tokenHash(token){
 if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))fail('Agendamento não encontrado ou link inválido.',404);
 return hash(token);
}
function createPublicBookings(db,clock=()=>new Date()){
 async function issue(appointmentId,capability){
  const token=capability ?? crypto.randomBytes(32).toString('hex');
  tokenHash(token);
  await db.runAsync('INSERT INTO public_booking_access (appointment_id,token_hash) VALUES ($1,$2)',[appointmentId,hash(token)]);
  return token;
 }
 async function lookup(where,params,lock=false){
  const row=await db.getAsync(`SELECT a.id,a.assinatura_id,a.nome_cliente,a.servico_nome,a.preco,a.data,a.hora,a.duracao,a.status,
   p.nome AS profissional,s.barbearia_nome,s.public_slug,s.cancellation_notice_minutes,
   (a.data || ' ' || a.hora)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS starts_at
   FROM agendamentos a LEFT JOIN public_booking_access t ON a.id=t.appointment_id
   JOIN assinaturas s ON s.id=a.assinatura_id LEFT JOIN profissionais p ON p.id=a.profissional_id AND p.assinatura_id=a.assinatura_id
   WHERE ${where} ${lock?'FOR UPDATE OF a,s':''}`,params);
  if(!row)fail('Agendamento não encontrado ou link inválido.',404);
  return row;
 }
 async function find(token,lock=false){return lookup('t.token_hash=$1',[tokenHash(token)],lock);}
 function contactIdentity(tenant,phone){
  if(!Number.isSafeInteger(tenant)||tenant<=0||!require('./whatsapp/phone').isBrazilianWhatsAppIdentity(phone))fail('Contato inválido.',400);
 }
 async function forContact(tenant,phone){
  contactIdentity(tenant,phone);
  const rows=await db.allAsync(`SELECT a.id,a.servico_nome,a.data,a.hora FROM agendamentos a
   WHERE a.assinatura_id=$1 AND a.telefone=$2
   AND a.status='confirmado' AND (a.data || ' ' || a.hora)::timestamp AT TIME ZONE 'America/Sao_Paulo'>$3
   ORDER BY a.data,a.hora,a.id`,[tenant,phone,clock()]);
  const available=[];
  for(const row of rows){const current=await lookup('a.id=$1 AND a.assinatura_id=$2 AND a.telefone=$3',[row.id,tenant,phone]);if(summary(current).cancelavel)available.push(row);}
  return available;
 }
 function summary(row){
  const remaining=+new Date(row.starts_at)-clock().getTime();
  let reason=null;
  if(row.status==='cancelado')reason='Este agendamento já está cancelado.';
  else if(row.status!=='confirmado')reason='Este agendamento não permite cancelamento.';
  else if(remaining<=0)reason='O horário deste agendamento já começou.';
  else if(remaining<row.cancellation_notice_minutes*60000)reason=`O estabelecimento permite cancelar com pelo menos ${row.cancellation_notice_minutes} minutos de antecedência.`;
  return {nome_cliente:row.nome_cliente,servico:row.servico_nome,preco:row.preco,data:row.data,hora:row.hora,
   duracao:row.duracao,status:row.status,profissional:row.profissional,estabelecimento:row.barbearia_nome,
   slug:row.public_slug,inicio:row.starts_at,futuro:remaining>0,cancelavel:!reason,motivo:reason,
   antecedencia_minutos:row.cancellation_notice_minutes};
 }
 async function get(token){return summary(await find(token));}
 async function context(token){const row=await find(token);return {tenantId:row.assinatura_id,reservationId:row.id};}
 // Called inside the same serialized transaction used by booking and rescheduling.
 async function applyCancellation(row){
  const current=summary(row);
  if(!current.cancelavel)fail(current.motivo,409);
  await transitionAppointment(db,row.assinatura_id,row.id,'cancelado',clock);
  return summary({...row,status:'cancelado'});
 }
 async function cancel(token){
  if(db.transaction)return db.transaction(c=>createPublicBookings(c,clock).cancel(token));
  const row=await find(token,true);
  // The existing reminder trigger cancels pending/sending reminders atomically.
  return applyCancellation(row);
 }
 // Internal domain capability: caller must authenticate the inbound phone via
 // webhook + persistent ownership. Never exposed as a public phone/ID endpoint.
 async function cancelForContact(tenant,phone,id){
  contactIdentity(tenant,phone);
  if(db.transaction)return db.transaction(c=>createPublicBookings(c,clock).cancelForContact(tenant,phone,id));
  return applyCancellation(await lookup('a.id=$1 AND a.assinatura_id=$2 AND a.telefone=$3',[id,tenant,phone],true));
 }
 return {issue,get,cancel,context,forContact,cancelForContact};
}
module.exports={createPublicBookings};
