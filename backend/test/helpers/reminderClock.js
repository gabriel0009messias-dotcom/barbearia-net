// Tests replace only their disposable schema's clock. Production always uses PG.
const clocks = new WeakMap();
async function setReminderClock(db, instant) {
 const schema=process.env.DATABASE_SCHEMA;
 if (!/^test_[a-f0-9]{32}$/.test(schema || '')) throw Error('Disposable test schema required');
 const iso=new Date(instant).toISOString();
 let clock=clocks.get(db);
 if (!clock || clock.schema!==schema) { clock={schema,pending:Promise.resolve(),iso:null};clocks.set(db,clock); }
 // Only clock DDL is serialized/coalesced. Worker drains still race normally.
 const setting=clock.pending.then(async()=>{
  if(clock.iso===iso)return;
  await db.runAsync(`CREATE OR REPLACE FUNCTION "${schema}".studiofy_reminder_now() RETURNS timestamptz
   LANGUAGE sql VOLATILE AS $$ SELECT '${iso}'::timestamptz $$`);
  clock.iso=iso;
 });
 clock.pending=setting.catch(()=>{});
 await setting;
}
function createReminderWorker(db,send,clock) {
 const worker=require('../../services/reminders').createReminderWorker(db,send,clock);
 return {drain:async()=>{if(clock)await setReminderClock(db,clock());return worker.drain();}};
}
module.exports={setReminderClock,createReminderWorker};
