const db=require('../../database');
process.on('message',()=>{}); // Keep deliberate crash barriers alive until killed.
const {createReminderWorker}=require('../../services/reminders');
async function main(){
 await db.ready;
 if(process.env.REMINDER_TEST_MODE==='before_claim') {process.send('ready');return new Promise(()=>{});}
 if(process.env.REMINDER_TEST_MODE==='claim') {
  await db.runAsync("UPDATE appointment_reminders SET status='sending',claim_token=gen_random_uuid(),claimed_at=clock_timestamp()-interval '3 minutes' WHERE reminder_kind='reminder_15m'");
  process.send('claimed');return new Promise(()=>{});
 }
 const wrapped=process.env.REMINDER_TEST_MODE==='after_frontier' ? {...db,runAsync:async(sql,args)=>{
  const result=await db.runAsync(sql,args);
  if(sql.includes('SET dispatch_started_at=CURRENT_TIMESTAMP,attempts=attempts+1')){process.send('frontier');await new Promise(()=>{});}
  return result;
 }} : db;
 await createReminderWorker(wrapped,async()=>{
  process.send('transport');
  if(process.env.REMINDER_TEST_MODE==='crash_transport')return new Promise(()=>{});
  return {key:{id:'synthetic-reminder'},status:'PENDING'};
 }).drain();
 await db.close();
}
main().then(()=>process.exit(0)).catch(()=>process.exit(1));
