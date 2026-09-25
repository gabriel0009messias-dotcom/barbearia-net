const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TRIAL_MS, trialState, accessState, identities } = require('../services/trial');
const start = Date.parse('2026-09-01T12:00:00.000Z');
const account = { status: 'pendente', trial_status: 'active', trial_started_at: new Date(start).toISOString(), trial_ends_at: new Date(start + TRIAL_MS) };
const unpaid = { liberado: false };

test('trial usa exatamente 168 horas, inclusive limite final e datas invalidas', () => {
  assert.equal(trialState(account, start).daysRemaining, 7);
  assert.equal(accessState(account, unpaid, start + TRIAL_MS - 1).status, 'trial_active');
  assert.equal(accessState(account, unpaid, start + TRIAL_MS).status, 'trial_expired');
  assert.equal(trialState({ ...account, trial_ends_at: new Date(start + TRIAL_MS + 1) }, start).status, 'expired');
  assert.equal(trialState({ ...account, trial_started_at: 'invalid' }, start).status, 'expired');
  assert.equal(trialState(account, start - 1).status, 'expired');
});
test('assinatura paga prevalece; trial nao reabre depois de pagamento ou bloqueio', () => {
  assert.equal(accessState(account, { liberado: true }, start).status, 'subscription_active');
  for (const extra of [{ payment_id: '123' }, { ultimo_pagamento: '2026-09-01' }, { bloqueado: 1 }, { status: 'cancelada' }]) {
    assert.equal(accessState({ ...account, ...extra }, unpaid, start).liberado, false);
  }
});
test('contas antigas nao ganham trial; verificacao de expiracao nao altera dados', () => {
  const old = { ...account, trial_status: null };
  assert.equal(accessState(old, unpaid, start).status, 'payment_required');
  const before = structuredClone(account);
  accessState(account, unpaid, start + TRIAL_MS);
  assert.deepEqual(account, before);
});
test('identidades normalizadas impedem repeticao com formatacao diferente', () => {
  assert.deepEqual(identities({email:' Owner@example.test ',telefone:'+55 (11) 99999-8888'}).hashes,
    identities({email:'owner@example.test',telefone:'11999998888'}).hashes);
});
test('autorizacao central preserva assinatura ativa e rejeita assinatura vencida', () => {
  const { avaliarAcessoAssinatura } = require('../services/access');
  assert.equal(avaliarAcessoAssinatura({status:'ativo',proximo_vencimento:'2099-01-01'}).status,'subscription_active');
  assert.equal(avaliarAcessoAssinatura({status:'ativo',proximo_vencimento:'2000-01-01'}).liberado,false);
  assert.equal(avaliarAcessoAssinatura({status:'pendente',acesso_manual_ate:'2099-01-01'}).liberado,true);
  assert.equal(avaliarAcessoAssinatura(null).liberado,false);
});
