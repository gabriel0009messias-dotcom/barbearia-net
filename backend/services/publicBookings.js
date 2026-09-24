const crypto=require('node:crypto');
const {fail}=require('./studiofy');
const hash=token=>crypto.createHash('sha256').update(token).digest('hex');
function tokenHash(token){
 if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))fail('Agendamento não encontrado ou link inválido.',404);
 return hash(token);
}
function createPublicBookings(db,clock=()=>new Date()){
 async function issue(appointmentId){
  const token=crypto.randomBytes(32).toString('hex');
  await db.runAsync('INSERT INTO public_booking_access (appointment_id,token_hash) VALUES ($1,$2)',[appointmentId,hash(token)]);
  return token;
 }
 async function find(token,lock=false){
  const row=await db.getAsync(`SELECT a.id,a.nome_cliente,a.servico_nome,a.preco,a.data,a.hora,a.duracao,a.status,
   p.nome AS profissional,s.barbearia_nome,s.public_slug,s.cancellation_notice_minutes,
   (a.data || ' ' || a.hora)::timestamp AT TIME ZONE 'America/Sao_Paulo' AS starts_at
   FROM public_booking_access t JOIN agendamentos a ON a.id=t.appointment_id
   JOIN assinaturas s ON s.id=a.assinatura_id LEFT JOIN profissionais p ON p.id=a.profissional_id
   WHERE t.token_hash=$1 ${lock?'FOR UPDATE OF a,s':''}`,[tokenHash(token)]);
  if(!row)fail('Agendamento não encontrado ou link inválido.',404);
  return row;
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
 // Called inside the same serialized transaction used by booking and rescheduling.
 async function cancel(token){
  const row=await find(token,true),current=summary(row);
  if(!current.cancelavel)fail(current.motivo,409);
  await db.runAsync("UPDATE agendamentos SET status='cancelado' WHERE id=$1",[row.id]);
  // The existing reminder trigger cancels pending/sending reminders atomically.
  return summary({...row,status:'cancelado'});
 }
 return {issue,get,cancel};
}
module.exports={createPublicBookings};
