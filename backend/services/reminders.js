const { createEvolutionDelivery, newDeliveryClaim } = require('./evolutionDelivery');
const { buildReminderMessage } = require('./appointmentReminderMessage');
const { executionScope: scope } = require('./executionScope');
function createReminderWorker(db, send, clock) {
 async function drain() {
  return scope.admit('reminder.drain', drainAdmitted);
 }
 async function drainAdmitted() {
  const delivery=createEvolutionDelivery(db);
  const now=clock ? clock() : new Date((await db.getAsync('SELECT studiofy_reminder_now() AS now')).now);
  await delivery.recoverInterrupted('appointment_reminders',new Date(now.getTime()-120000));
  if (!scope.isOpen()) return;
  // One bounded expiration pass per cycle, rather than one UPDATE per candidate.
  await db.runAsync(`WITH expired AS (SELECT id FROM appointment_reminders
   WHERE status='pending' AND reminder_kind<>'legacy_20m' AND due_at<=$1 AND expires_at<=$1
   ORDER BY due_at,id LIMIT 50 FOR UPDATE SKIP LOCKED)
   UPDATE appointment_reminders r SET status='expired' FROM expired e WHERE r.id=e.id`,[now]);
  const visited=[];
  for (let i=0;i<50;i++) {
   if (!scope.isOpen()) return;
   const row=await db.transaction(async c=>{
    const r=await c.getAsync(`SELECT r.* FROM appointment_reminders r
     WHERE r.status='pending' AND r.reminder_kind<>'legacy_20m' AND r.due_at<=$1 AND r.expires_at>$1
      AND studiofy_appointment_transport_allowed(r.assinatura_id)
      AND NOT (r.id=ANY($2::bigint[]))
      AND r.dispatch_started_at IS NULL AND (r.attempts=0 OR r.claim_token IS NOT NULL)
      AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=$1)
      AND NOT EXISTS(SELECT 1 FROM appointment_reminders used WHERE used.assinatura_id=r.assinatura_id
       AND used.appointment_id=r.appointment_id AND used.reminder_kind=r.reminder_kind AND used.status IN ('sending','sent','uncertain'))
     ORDER BY r.due_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,[now,visited]);
    if (!r) return null;
    if (!scope.isOpen()) return null;
    // Appointment writers lock appointment before reminder. Never wait in reverse.
    const appointment=await c.getAsync('SELECT id,status FROM agendamentos WHERE id=$1 AND assinatura_id=$2 FOR SHARE NOWAIT',[r.appointment_id,r.assinatura_id]);
    // Refresh related display data only for the original instance. Ownership
    // changes must be rejected, never silently rerouted to another instance.
    const live=await c.getAsync('SELECT studiofy_reminder_snapshot($1,$2) AS snapshot',[r.assinatura_id,r.appointment_id]);
    if (appointment && live?.snapshot?.instance===r.snapshot.instance)
     await c.runAsync('SELECT studiofy_reminder_refresh($1,$2)',[r.assinatura_id,r.appointment_id]);
    const origin=await c.getAsync('SELECT schedule_revision FROM appointment_reminder_origins WHERE appointment_id=$1 AND assinatura_id=$2',[r.appointment_id,r.assinatura_id]);
    if (!appointment || appointment.status!=='confirmado' || origin?.schedule_revision!==r.schedule_revision) {
     await c.runAsync("UPDATE appointment_reminders SET status='cancelled',last_error='Appointment context superseded.' WHERE id=$1",[r.id]);return {skip:true};
    }
    let response;
    try { response=buildReminderMessage(r); }
    catch { await c.runAsync("UPDATE appointment_reminders SET status='cancelled',last_error='Invalid reminder recipient or snapshot.' WHERE id=$1",[r.id]);return {skip:true}; }
    const claim=newDeliveryClaim();
    if (!scope.isOpen()) return null;
    await c.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=$1,operation_token=NULL,dispatch_started_at=NULL,claimed_at=$2 WHERE id=$3",[claim,now,r.id]);
    return {...r,claim_token:claim,response,instance:r.snapshot.instance,phone:r.destination};
   },{serialize:false}).catch(error=>{if (['55P03','23505'].includes(error.code)) return null;throw error;});
   if (!row) return;
   if (!scope.isOpen()) return;
   if (row.skip) continue;
   visited.push(row.id);
   const account=await db.getAsync('SELECT * FROM assinaturas WHERE id=$1',[row.assinatura_id]);
   if (!require('./access').avaliarAcessoAssinatura(account).liberado) {
    await db.runAsync("UPDATE appointment_reminders SET status='cancelled',last_error='Acesso operacional indisponivel.' WHERE id=$1 AND claim_token=$2 AND status='sending'",[row.id,row.claim_token]);continue;
   }
   await delivery.dispatch('appointment_reminders',row,send,{validate:async()=>{
    const policy=await db.getAsync('SELECT studiofy_appointment_transport_allowed($1) AS allowed',[row.assinatura_id]);
    // Suspension is a safe deferral, not a failed delivery. The SQL trigger
    // independently closes the gap between this read and durable intent.
    if(policy?.allowed!==true)throw Object.assign(new Error('Appointment reminder transport deferred.'),{code:'APPOINTMENT_REMINDER_TRANSPORT_DEFERRED'});
    const current=await db.getAsync(`SELECT o.schedule_revision,studiofy_reminder_snapshot($1,$2) AS snapshot,
      studiofy_reminder_now() AS now FROM appointment_reminder_origins o WHERE o.assinatura_id=$1 AND o.appointment_id=$2`,[row.assinatura_id,row.appointment_id]);
    return current?.schedule_revision===row.schedule_revision && current.snapshot?.status==='confirmado' &&
      JSON.stringify(current.snapshot)===JSON.stringify(row.snapshot) && new Date(current.now)>=new Date(row.due_at) && new Date(current.now)<new Date(row.expires_at);
   }});
  }
 }
 return {drain};
}
const workerStatus={startedAt:null,lastCompletedAt:null,lastErrorAt:null,running:false};
function getWorkerStatus() { return {...workerStatus}; }
function startWorker(db, { drain: customDrain, intervalMs = 1000, taskScope = scope } = {}) {
 taskScope.assertOpen();
 const worker=createReminderWorker(db,require('../evolutionApi').enviarTextoInstancia);
 let running=false, stopped=false, flight;
 const completions=new Set();
 workerStatus.startedAt=new Date().toISOString();
 const run=()=>{
  if(running||stopped||!taskScope.isOpen())return;
  running=true;workerStatus.running=true;
  flight=taskScope.admitRoot('reminder.run',async()=>{
   try{await (customDrain||worker.drain)();workerStatus.lastCompletedAt=new Date().toISOString();}
   catch{workerStatus.lastErrorAt=new Date().toISOString();console.error('[Studiofy] Falha ao processar lembretes.');}
   finally{running=false;workerStatus.running=false;}
  },{canAdmit:()=>!stopped});
  const completion=flight.completion;completions.add(completion);
  completion.then(()=>completions.delete(completion));
  return flight;
 };
 run();const timer=setInterval(run,intervalMs);timer.unref();
 timer.stop=require('./executionCapabilities').coordinatorFor(taskScope).register('scheduler.reminders',()=>{stopped=true;clearInterval(timer);return Promise.all([...completions]);});
 return timer;
}
module.exports={createReminderWorker,startWorker,getWorkerStatus};
