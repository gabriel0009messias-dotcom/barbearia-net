// An ambiguous provider outcome is never retried automatically: Evolution does not
// promise an idempotency key. This trades a possible missed delivery for no duplicate.
function createReminderWorker(db,send,clock=()=>new Date()) {
 async function drain() {
  await db.runAsync("UPDATE appointment_reminders SET status='uncertain',last_error='Processo interrompido durante envio; verificar entrega antes de reenviar.' WHERE status='sending' AND claimed_at < $1",[new Date(clock().getTime()-120000)]);
  for(let i=0;i<50;i++) {
   const row=await db.transaction(async c=>{
    await c.runAsync("UPDATE appointment_reminders SET status='expired' WHERE status='pending' AND due_at + interval '20 minutes' <= $1",[clock()]);
    const r=await c.getAsync(`SELECT r.*,a.nome_cliente,a.telefone,a.servico_nome,a.hora,a.data,p.nome AS profissional,s.barbearia_nome,s.whatsapp_session
     FROM appointment_reminders r JOIN agendamentos a ON a.id=r.appointment_id
     JOIN assinaturas s ON s.id=r.assinatura_id LEFT JOIN profissionais p ON p.id=a.profissional_id
     WHERE r.status='pending' AND r.due_at<=$1 AND a.status='confirmado' AND s.whatsapp_session IS NOT NULL
     ORDER BY r.due_at LIMIT 1 FOR UPDATE OF r,a`,[clock()]);
    if(r)await c.runAsync("UPDATE appointment_reminders SET status='sending',attempts=attempts+1,claimed_at=$1 WHERE id=$2",[clock(),r.id]);
    return r;
   });
   if(!row)return;
   // Lock this appointment through delivery: cancellation/rescheduling waits for
   // this row only, without holding the global scheduling lock during HTTP I/O.
   // The durable claim survives a crash and cannot be claimed by another worker.
   await db.transaction(async c=>{
    const current=await c.getAsync(`SELECT r.status,r.due_at,a.status AS appointment_status,a.nome_cliente,a.telefone,a.servico_nome,a.hora,a.data,
      p.nome AS profissional,s.barbearia_nome,s.whatsapp_session
      FROM appointment_reminders r JOIN agendamentos a ON a.id=r.appointment_id
      JOIN assinaturas s ON s.id=r.assinatura_id LEFT JOIN profissionais p ON p.id=a.profissional_id
      WHERE r.id=$1 FOR UPDATE OF r,a`,[row.id]);
    if(!current || current.status!=='sending' || current.appointment_status!=='confirmado' || +new Date(current.due_at)!==+new Date(row.due_at))return;
    if(clock().getTime()>=new Date(current.due_at).getTime()+1200000){await c.runAsync("UPDATE appointment_reminders SET status='expired' WHERE id=$1",[row.id]);return;}
    Object.assign(row,current);
    try {
     await send(row.whatsapp_session,row.telefone,`Olá, ${row.nome_cliente}! 👋\n\nSeu horário está chegando.\nServiço: ${row.servico_nome}\nProfissional: ${row.profissional || row.barbearia_nome}\nHorário: ${row.hora}\n\n${clock().getTime()-new Date(row.due_at).getTime()<60000?'Faltam 20 minutos para seu atendimento.':'Lembrete do seu atendimento de hoje.'}\n\n${row.barbearia_nome}`);
     await c.runAsync("UPDATE appointment_reminders SET status='sent',sent_at=$1,last_error=NULL WHERE id=$2",[clock(),row.id]);
    }catch{
     await c.runAsync("UPDATE appointment_reminders SET status='uncertain',last_error='Entrega não confirmada pela Evolution. Verifique o WhatsApp antes de reenviar.' WHERE id=$1",[row.id]);
    }
   }, {serialize:false});
  }
 }
 return {drain};
}
const workerStatus={startedAt:null,lastCompletedAt:null,lastErrorAt:null,running:false};
function getWorkerStatus() { return {...workerStatus}; }
function startWorker(db) {
 const worker=createReminderWorker(db,require('../evolutionApi').enviarTextoInstancia);
 let running=false;
 workerStatus.startedAt=new Date().toISOString();
 const run=async()=>{if(running)return;running=true;workerStatus.running=true;try{await worker.drain();workerStatus.lastCompletedAt=new Date().toISOString();}catch{workerStatus.lastErrorAt=new Date().toISOString();console.error('[Studiofy] Falha ao processar lembretes.');}finally{running=false;workerStatus.running=false;}};
 void run();const timer=setInterval(run,1000);timer.unref();return timer;
}
module.exports={createReminderWorker,startWorker,getWorkerStatus};
