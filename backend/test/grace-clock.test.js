const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { avaliarAcessoAssinatura, calcularResumoPagamento } = require('../services/access');
const { GRACE_MS, expiryInstant, instant } = require('../services/billingTime');
const due = Date.parse('2026-10-10T15:30:00.000-03:00');
const account = { status: 'ativo', ultimo_pagamento: '2026-09-10', vencimento_em: new Date(due), proximo_vencimento: '2026-10-10' };
for (const [offset, status, allowed] of [[-1,'subscription_active',true],[0,'subscription_active',true],[1,'grace_period',true],[GRACE_MS-1,'grace_period',true],[GRACE_MS,'payment_required',false],[GRACE_MS+1,'payment_required',false]]) {
  test(`fronteira de vencimento: ${offset} ms`, () => {
    const state = avaliarAcessoAssinatura(account, due + offset);
    assert.equal(state.status, status); assert.equal(state.liberado, allowed);
    assert.equal(state.toleranciaAte, '2026-10-14T18:30:00.000Z');
    assert.equal(state.toleranciaRestanteMs, offset > 0 && offset < GRACE_MS ? GRACE_MS-offset : 0);
    if (!allowed) assert.equal(state.motivo,'subscription_expired');
  });
}
for (const TZ of ['UTC','America/Sao_Paulo','America/New_York']) {
  test(`decisao equivalente em processo independente TZ=${TZ}`, () => {
    const script = `const {avaliarAcessoAssinatura:a}=require('./services/access'); const {expiryInstant:e}=require('./services/billingTime');const x=${JSON.stringify({...account,vencimento_em:account.vencimento_em.toISOString()})};console.log(JSON.stringify({states:${JSON.stringify([-1,0,1,GRACE_MS-1,GRACE_MS,GRACE_MS+1])}.map(n=>a(x,${due}+n)),legacy:e({proximo_vencimento:'2026-10-10'})}));`;
    const result = spawnSync(process.execPath,['-e',script],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const output=JSON.parse(result.stdout);
    assert.deepEqual(output.states,[-1,0,1,GRACE_MS-1,GRACE_MS,GRACE_MS+1].map(n=>avaliarAcessoAssinatura(account,due+n)));
    assert.equal(output.legacy,Date.parse('2026-10-10T00:00:00-03:00'));
  });
}
test('suspensao administrativa vence tolerancia e dias manuais', () => {
  const blocked={...account,bloqueio_admin:true,acesso_manual_ate:'2099-01-01T00:00:00Z'};
  assert.equal(avaliarAcessoAssinatura(blocked,due+1).status,'admin_blocked');
  assert.equal(avaliarAcessoAssinatura(blocked,due+1).liberado,false);
});
test('datas ambiguas e invalidas falham fechadas; instante preciso tem prioridade', () => {
  for(const value of ['2026-02-30T12:00:00Z','2026-10-10T15:30:00','10/10/2026','2026-10-10garbage']) assert.ok(Number.isNaN(instant(value)));
  assert.ok(Number.isNaN(expiryInstant({proximo_vencimento:'2026-02-30'})));
  assert.equal(expiryInstant(account),due);
  assert.equal(avaliarAcessoAssinatura({...account,vencimento_em:'invalid'},due).liberado,false);
  const before=structuredClone(account);calcularResumoPagamento(account,due+GRACE_MS);assert.deepEqual(account,before);
});
test('data de vencimento sozinha nao libera pendente e estorno nao vira tolerancia',()=>{
  assert.equal(avaliarAcessoAssinatura({...account,status:'pendente'},due+1).liberado,false);
  assert.equal(avaliarAcessoAssinatura({status:'ativo'},due).liberado,false,'Legacy active without due requires regularization');
  for(const gateway_status of ['refunded','charged_back','cancelled'])assert.equal(avaliarAcessoAssinatura({...account,gateway_status},due+1).liberado,false);
});
