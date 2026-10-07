const {test}=require('node:test');
const assert=require('node:assert/strict');
const {localMoment,appointmentPermissions}=require('../services/agenda');
const {assertTransition,assertReschedule,appointmentId}=require('../services/agenda');

test('Agenda: conclusão só de confirmado a partir do horário agendado',()=>{
 const moment=localMoment(new Date('2026-09-28T12:30:00Z'));
 assert.deepEqual(moment,{date:'2026-09-28',time:'09:30'});
 const appointment={data:'2026-09-28',hora:'09:30',status:'confirmado'};
 assert.equal(appointmentPermissions(appointment,moment).pode_concluir,true);
 for(const change of [{hora:'09:31'},{data:'2026-09-29'}]){
  const result=appointmentPermissions({...appointment,...change},moment);
  assert.equal(result.futuro,true);assert.equal(result.pode_concluir,false);assert.match(result.motivo_conclusao,/futuro/);
 }
 for(const status of ['cancelado','concluido','falta','pendente'])assert.equal(appointmentPermissions({...appointment,status},moment).pode_concluir,false);
 assert.equal(appointmentPermissions({...appointment,data:'2026-09-27'},moment).pode_concluir,true);
});
test('Agenda: data e horário usam São Paulo na virada do dia',()=>{
 const moment=localMoment(new Date('2026-10-01T02:59:00Z'));
 assert.deepEqual(moment,{date:'2026-09-30',time:'23:59'});
 assert.equal(appointmentPermissions({data:'2026-10-01',hora:'00:00',status:'confirmado'},moment).pode_concluir,false);
});

test('Agenda: matriz central preserva finais e só permite falta e conclusão a partir do início',()=>{
 const moment={date:'2026-10-06',time:'09:30'};
 const confirmed={data:'2026-10-06',hora:'09:30',status:'confirmado'};
 for(const target of ['confirmado','concluido','cancelado','falta'])assert.doesNotThrow(()=>assertTransition(confirmed,target,moment));
 for(const source of ['concluido','cancelado','falta','pendente'])for(const target of ['confirmado','concluido','cancelado','falta']){
  assert.throws(()=>assertTransition({...confirmed,status:source},target,moment),e=>e.statusCode===409);
 }
 const future={...confirmed,hora:'09:31'};
 for(const status of ['concluido','falta'])assert.throws(()=>assertTransition(future,status,moment),e=>e.statusCode===409);
 assert.doesNotThrow(()=>assertTransition(future,'cancelado',moment));
 assert.doesNotThrow(()=>assertReschedule(future,moment));
 assert.throws(()=>assertReschedule(confirmed,moment),e=>e.statusCode===409);
 assert.throws(()=>assertTransition(confirmed,'inexistente',moment),e=>e.statusCode===400);
});

test('Agenda: IDs e datas incompletas não liberam mutações indevidas',()=>{
 for(const id of ['abc',0,-1,'1e2','1 OR 1=1','99999999999999999999999999',null,undefined])assert.throws(()=>appointmentId(id),e=>e.statusCode===400);
 assert.equal(appointmentId('42'),42);
 for(const fields of [{data:null},{hora:null},{data:'2026-02-30'},{hora:'24:00'}]){
  const a={status:'confirmado',data:'2026-10-06',hora:'09:00',...fields};
  assert.equal(appointmentPermissions(a,{date:'2026-10-06',time:'12:00'}).pode_concluir,false);
  for(const status of ['concluido','falta'])assert.throws(()=>assertTransition(a,status,{date:'2026-10-06',time:'12:00'}),e=>e.statusCode===409);
 }
});
