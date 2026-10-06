const {test}=require('node:test');
const assert=require('node:assert/strict');
const {financialSummary}=require('../services/finance');

const now=new Date('2026-10-15T15:00:00Z'); // 12:00 in São Paulo, Thursday.
const booking=(id,data,preco,status='concluido',extra={})=>({id,data,preco,status,hora:'09:00',
 nome_cliente:'Cliente '+id,servico_nome:'Corte',studio_service_id:1,profissional:'Ana',...extra});
const rows=[booking(1,'2026-10-15',30.10),booking(2,'2026-10-15',20.20),
 booking(3,'2026-10-12',40),booking(4,'2026-10-11',50),booking(5,'2026-10-01',60),
 booking(6,'2026-09-30',1250,'concluido',{servico_nome:'Tratamento',studio_service_id:2})];

test('Financeiro: faturamento diário, semanal e mensal em centavos',()=>{
 const f=financialSummary(rows,now);
 assert.deepEqual(f.hoje,{atendimentos:2,valor_centavos:5030});
 assert.deepEqual(f.semana,{atendimentos:3,valor_centavos:9030});
 assert.deepEqual(f.mes,{atendimentos:5,valor_centavos:20030});
 assert.deepEqual(f.total,{atendimentos:6,valor_centavos:145030});
 assert.equal(f.inicio_semana,'2026-10-12');
 assert.deepEqual(f.meses.map(m=>m.mes),['2026-10','2026-09']);
});
test('Financeiro: apenas concluídos; exclui cancelado, pendente, confirmado, falta e futuros',()=>{
 const excluded=['cancelado','pendente','confirmado','falta'].map((s,i)=>booking(20+i,'2026-10-14',900,s));
 excluded.push(booking(30,'2026-10-16',900),booking(31,'2026-10-15',900,'concluido',{hora:'12:01'}));
 const f=financialSummary([...rows,...excluded],now);
 assert.deepEqual(f,financialSummary(rows,now));
 assert.equal(financialSummary([booking(40,'2026-10-15',30,'concluido',{hora:'12:00'})],now).hoje.atendimentos,1);
});
test('Financeiro: ranking, valores por serviço e histórico usam os preços dos atendimentos',()=>{
 const f=financialSummary(rows,now);
 assert.deepEqual(f.servicos,[{servico:'Corte',atendimentos:5,valor_centavos:20030},
  {servico:'Tratamento',atendimentos:1,valor_centavos:125000}]);
 assert.deepEqual(f.historico.map(a=>a.id),[2,1,3,4,5,6]);
 assert.equal(f.historico.find(a=>a.id===1).valor_centavos,3010);
 assert.equal(f.servicos.reduce((sum,s)=>sum+s.valor_centavos,0),f.total.valor_centavos);
});
test('Financeiro: virada do mês e da semana e fuso de São Paulo',()=>{
 const f=financialSummary([booking(1,'2026-09-28',30),booking(2,'2026-09-27',40),
  booking(3,'2026-09-30',50),booking(4,'2026-10-01',60)],new Date('2026-10-01T02:30:00Z'));
 assert.equal(f.referencia,'2026-09-30');assert.equal(f.inicio_semana,'2026-09-28');
 assert.equal(f.hoje.valor_centavos,5000);assert.equal(f.semana.valor_centavos,8000);assert.equal(f.mes.valor_centavos,12000);
 const next=financialSummary([booking(1,'2026-09-28',30),booking(2,'2026-10-01',60)],new Date('2026-10-01T15:00:00Z'));
 assert.equal(next.semana.valor_centavos,9000);assert.equal(next.mes.valor_centavos,6000);
});
test('Financeiro: domingo pertence à semana anterior; janeiro não inclui dezembro no mês',()=>{
 assert.equal(financialSummary([],new Date('2026-10-18T15:00:00Z')).inicio_semana,'2026-10-12');
 const f=financialSummary([booking(1,'2026-12-31',30),booking(2,'2027-01-01',40)],new Date('2027-01-01T15:00:00Z'));
 assert.equal(f.mes.valor_centavos,4000);assert.equal(f.semana.valor_centavos,7000);
});
test('Financeiro: serviços distintos com mesmo nome não são misturados; legado sem ID funciona',()=>{
 const f=financialSummary([booking(1,'2026-10-15',30),booking(2,'2026-10-15',40,'concluido',{studio_service_id:2}),
  booking(3,'2026-10-15',10,'concluido',{studio_service_id:null})],now);
 assert.equal(f.servicos.length,3);assert.equal(f.total.valor_centavos,8000);
});
test('Financeiro: estabelecimento sem atendimentos recebe zeros e histórico vazio',()=>{
 const f=financialSummary([],now);
 for(const period of ['hoje','semana','mes','total'])assert.deepEqual(f[period],{atendimentos:0,valor_centavos:0});
 assert.deepEqual(f.servicos,[]);assert.deepEqual(f.historico,[]);assert.deepEqual(f.meses,[]);
});
