const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { avaliarAcessoAssinatura, calcularResumoPagamento } = require('../services/access');
const { TRIAL_MS } = require('../services/trial');
const now = Date.parse('2026-10-10T18:30:00.123Z');
const paid = { status:'ativo',status_assinatura:'ATIVA',ultimo_pagamento:'2026-09-10',payment_id:'fixture' };
for (const [name,fields] of [
  ['NULL',{proximo_vencimento:null,vencimento_em:null}],
  ['ausente',{}],['vazio',{proximo_vencimento:''}],
  ['texto invalido',{proximo_vencimento:'invalid'}],
  ['calendario impossivel',{proximo_vencimento:'2026-02-30'}],
  ['hora sem offset',{proximo_vencimento:'2026-10-10T15:30:00'}],
  ['instante invalido prevalece',{vencimento_em:'invalid',proximo_vencimento:'2099-01-01'}],
  ['apenas espelho',{data_vencimento:'2099-01-01'}],
  ['apenas gateway',{mercado_next_payment_date:'2099-01-01T00:00:00Z',gateway_status:'approved'}],
]) test('ativo sem vencimento confiavel: '+name,()=>{
  const account={...paid,...fields},before=structuredClone(account);
  const state=avaliarAcessoAssinatura(account,now);
  assert.equal(state.liberado,false);assert.equal(state.status,'subscription_irregular');
  assert.equal(state.motivo,'subscription_requires_regularization');
  assert.equal(state.vencimentoEm,null);assert.deepEqual(account,before);
  const summary=calcularResumoPagamento(account,now);
  assert.equal(summary.requerRegularizacao,true);assert.equal(summary.statusSugerido,'ativo');
});
test('trial valido sem evidencia de pagamento continua independente de status legado irregular',()=>{
  const account={status:'ativo',proximo_vencimento:'invalid',trial_status:'active',trial_started_at:new Date(now-1000).toISOString(),trial_ends_at:new Date(now-1000+TRIAL_MS)};
  assert.equal(avaliarAcessoAssinatura(account,now).status,'trial_active');
  assert.equal(avaliarAcessoAssinatura({...account,...paid},now).liberado,false,'Trial convertido nao reabre');
  assert.equal(avaliarAcessoAssinatura(account,now-1000+TRIAL_MS).liberado,false);
});
test('manual libera so durante prazo; fim retorna a regularizacao sem pagamento ficticio',()=>{
  const account={...paid,acesso_manual_ate:new Date(now+1).toISOString()};
  assert.equal(avaliarAcessoAssinatura(account,now).status,'manual_access');
  assert.equal(avaliarAcessoAssinatura(account,now+1).status,'subscription_irregular');
  assert.equal(account.ultimo_pagamento,paid.ultimo_pagamento);
});
test('Admin sempre vence trial manual legado pago e tolerancia',()=>{
  for(const fields of [{},{acesso_manual_ate:'2099-01-01T00:00:00Z'},{proximo_vencimento:'2099-01-01'},{vencimento_em:new Date(now-1)}]){
    const state=avaliarAcessoAssinatura({...paid,...fields,bloqueio_admin:true},now);
    assert.equal(state.status,'admin_blocked');assert.equal(state.liberado,false);
  }
});
test('assinatura normal e tolerancia mantem fronteiras e prioridade do instante confiavel',()=>{
  assert.equal(avaliarAcessoAssinatura({...paid,proximo_vencimento:'2099-01-01'},now).status,'subscription_active');
  const account={...paid,vencimento_em:new Date(now),proximo_vencimento:'invalid'};
  assert.equal(avaliarAcessoAssinatura(account,now).status,'subscription_active');
  assert.equal(avaliarAcessoAssinatura(account,now+345600000-1).status,'grace_period');
  assert.equal(avaliarAcessoAssinatura(account,now+345600000).liberado,false);
});
for(const TZ of ['UTC','America/Sao_Paulo','America/New_York'])test('legado irregular independe de TZ='+TZ,()=>{
  const result=spawnSync(process.execPath,['-e',`const a=require('./services/access').avaliarAcessoAssinatura;console.log(JSON.stringify([a(${JSON.stringify(paid)},${now}),a(${JSON.stringify({...paid,proximo_vencimento:'2099-01-01'})},${now})]));`],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),[avaliarAcessoAssinatura(paid,now),avaliarAcessoAssinatura({...paid,proximo_vencimento:'2099-01-01'},now)]);
});
