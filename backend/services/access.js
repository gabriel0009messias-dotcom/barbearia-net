const { accessState, adminBlockState } = require('./trial');
const { DAY_MS, GRACE_MS, expiryInstant } = require('./billingTime');
function acessoManualAtivo(account, now = Date.now()) {
  return !adminBlockState(account, now) && Date.parse(account?.acesso_manual_ate || '') > now;
}
function calcularResumoPagamento(account, now = Date.now()) {
  const administrative = adminBlockState(account, now);
  const due = expiryInstant(account), valid = Number.isFinite(due);
  const elapsed = valid ? now - due : 0;
  const grace = valid && elapsed > 0 && elapsed < GRACE_MS;
  const expired = valid && elapsed >= GRACE_MS;
  const canceled = ['cancelled','canceled','refunded','charged_back'].includes(String(account?.gateway_status || '').toLowerCase()) || account?.status === 'cancelada' || account?.status_assinatura === 'CANCELADA';
  const manual = acessoManualAtivo(account, now);
  const eligible = ['ativo','ativa','atrasada'].includes(account?.status);
  const irregular = !valid && (eligible || Boolean(account?.payment_id || account?.ultimo_pagamento) || String(account?.status_assinatura || '').toUpperCase() === 'ATIVA');
  let status = account?.status || 'pendente', blocked = Number(account?.bloqueado || 0) === 1;
  let message = 'Pagamento pendente. Conclua a assinatura para liberar o sistema.';
  let indicator = valid ? 'Pagamento pendente' : 'Sem vencimento valido';
  if (administrative) { status = 'bloqueado'; blocked = true; message = administrative.mensagem; indicator = 'Bloqueado pelo administrador'; }
  else if (manual) { status = 'ativa'; blocked = false; message = 'Seu acesso temporario esta liberado.'; indicator = 'Acesso liberado pelo administrador'; }
  else if (canceled) { status = 'cancelada'; blocked = true; message = 'Sua assinatura foi cancelada ou o pagamento estornado. Regularize para voltar a usar o sistema.'; indicator = 'Cancelada'; }
  else if (expired) { status = 'bloqueada'; blocked = true; message = 'Sua assinatura expirou apos as 96 horas de tolerancia. Seus dados continuam salvos.'; indicator = 'Assinatura expirada'; }
  else if (irregular) { message = 'Sua assinatura requer regularizacao. Seus dados continuam salvos. Entre em contato com o suporte ou realize um novo pagamento.'; indicator = 'Assinatura requer regularizacao'; }
  else if (eligible && !blocked && valid) {
    status = grace ? 'atrasada' : 'ativa';
    message = grace ? 'Sua assinatura esta em tolerancia. Regularize antes do fim das 96 horas.' : 'Assinatura ativa.';
    indicator = grace ? 'Tolerancia de 96 horas' : 'Em dia';
  }
  return { diasAtraso: Math.max(0, Math.floor(elapsed / DAY_MS)), diasParaVencer: valid ? Math.max(0, Math.ceil(-elapsed / DAY_MS)) : 0,
    atrasado: elapsed > 0, venceHoje: valid && elapsed <= 0 && -elapsed < DAY_MS,
    bloqueiaHoje: grace && GRACE_MS - elapsed <= DAY_MS, bloqueadoAutomatico: expired,
    statusSugerido: status, statusAssinaturaSugerido: ({ ativa: 'ATIVA', ativo: 'ATIVA', atrasada: 'ATRASADA', bloqueada: 'BLOQUEADA', bloqueado: 'BLOQUEADA', cancelada: 'CANCELADA' })[status] || String(account?.status_assinatura || 'PENDENTE').toUpperCase(),
    bloqueado: blocked, requerRegularizacao: irregular && !administrative && !manual && !canceled,
    indicadorAtraso: indicator, mensagemAdmin: message, mensagemCliente: message,
    vencimentoEm: valid ? new Date(due).toISOString() : null,
    toleranciaAte: valid ? new Date(due + GRACE_MS).toISOString() : null,
    toleranciaRestanteMs: grace ? GRACE_MS - elapsed : 0 };
}
function avaliarAcessoAssinatura(account, now = Date.now()) {
  const administrative = adminBlockState(account, now);
  if (administrative) return administrative;
  const summary = calcularResumoPagamento(account, now);
  const manual = acessoManualAtivo(account, now);
  const allowed = !summary.bloqueado && (manual || summary.vencimentoEm !== null) && ['ativa','ativo','atrasada'].includes(summary.statusSugerido);
  const billing = { liberado: allowed, motivo: manual ? 'manual_access' : allowed ? summary.statusSugerido === 'atrasada' ? 'grace_period' : 'assinatura_ativa' : summary.requerRegularizacao ? 'subscription_requires_regularization' : summary.bloqueadoAutomatico ? 'subscription_expired' : 'pagamento_pendente',
    mensagem: summary.mensagemCliente, vencimentoEm: summary.vencimentoEm, toleranciaAte: summary.toleranciaAte, toleranciaRestanteMs: allowed && !manual ? summary.toleranciaRestanteMs : 0 };
  // Keep the stored status for legacy suspension detection. Financial projection
  // may display 'bloqueada', but must never manufacture an Admin suspension.
  return accessState(account ? { ...account, bloqueado: summary.bloqueado ? 1 : 0 } : account, billing, now);
}
module.exports = { acessoManualAtivo, calcularResumoPagamento, avaliarAcessoAssinatura };
