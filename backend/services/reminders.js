const { createEvolutionDelivery, newDeliveryClaim } = require('./evolutionDelivery');
function createReminderWorker(db, send, clock = () => new Date()) {
 async function drain() {
  await createEvolutionDelivery(db).recoverInterrupted('appointment_reminders',new Date(clock().getTime()-120000));
  for (let i=0;i<50;i++) {
   const row=await db.transaction(async c=>{
    await c.runAsync("UPDATE appointment_reminders SET status='expired' WHERE status='pending' AND due_at+interval '20 minutes'<=$1",[clock()]);
    const r=await c.getAsync(`SELECT r.*,a.nome_cliente,a.telefone,a.servico_nome,a.hora,a.data,p.nome AS profissional,s.barbearia_nome,s.whatsapp_session
     FROM appointment_reminders r JOIN agendamentos a ON a.id=r.appointment_id
     JOIN assinaturas s ON s.id=r.assinatura_id LEFT JOIN profissionais p ON p.id=a.profissional_id
     WHERE r.status='pending' AND r.due_at<=$1 AND a.status='confirmado'
      AND r.dispatch_started_at IS NULL AND (r.attempts=0 OR r.claim_token IS NOT NULL)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=CURRENT_TIMESTAMP)
     ORDER BY r.due_at LIMIT 1 FOR UPDATE OF r,a SKIP LOCKED`,[clock()]);
    if (!r) return null;
    const claim = newDeliveryClaim();
    await c.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1,operation_token=NULL,dispatch_started_at=NULL,claimed_at=$2 WHERE id=$3",[claim,clock(),r.id]);
    return {...r,claim_token:claim};
   },{serialize:false});
   if (!row) return;
   const account=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[row.assinatura_id]);
   if (!require('./access').avaliarAcessoAssinatura(account).liberado) {
    await db.runAsync("UPDATE appointment_reminders SET status='cancelled',last_error='Acesso operacional indisponivel.' WHERE id=$1 AND claim_token=$2 AND status='sending'",[row.id,row.claim_token]);
    continue;
   }
   const response=`Olá, ${row.nome_cliente}! 👋\n\nSeu horário está chegando.\nServiço: ${row.servico_nome}\nProfissional: ${row.profissional || row.barbearia_nome}\nHorário: ${row.hora}\n\n${clock().getTime()-new Date(row.due_at).getTime()<60000?'Faltam 20 minutos para seu atendimento.':'Lembrete do seu atendimento de hoje.'}\n\n${row.barbearia_nome}`;
   await createEvolutionDelivery(db).dispatch('appointment_reminders',{
    ...row, instance:row.whatsapp_session,phone:row.telefone,response,
   },send,{validate:async()=>{
    const current=await db.getAsync('SELECT status,data,hora FROM agendamentos WHERE id=$1 AND assinatura_id=$2',[row.appointment_id,row.assinatura_id]);
    return current?.status==='confirmado' && current.data===row.data && current.hora===row.hora && clock().getTime()<new Date(row.due_at).getTime()+1200000;
   }});
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
