// Tests replace only their disposable schema's clock. Production always uses PG.
async function setReminderClock(db, instant) {
 const schema=process.env.DATABASE_SCHEMA;
 if (!/^test_[a-f0-9]{32}$/.test(schema || '')) throw Error('Disposable test schema required');
 const iso=new Date(instant).toISOString();
 await db.runAsync(`CREATE OR REPLACE FUNCTION "${schema}".studiofy_reminder_now() RETURNS timestamptz
  LANGUAGE sql VOLATILE AS $$ SELECT '${iso}'::timestamptz $$`);
}
function createReminderWorker(db,send,clock) {
 const worker=require('../../services/reminders').createReminderWorker(db,send,clock);
 return {drain:async()=>{if(clock)await setReminderClock(db,clock());return worker.drain();}};
}
module.exports={setReminderClock,createReminderWorker};
