// Public HTTP and persistence projection. Never serialize arbitrary exception fields.
const { sanitize, logEvolution, PUBLIC_ERROR_CODES: CODES } = require('./evolutionLog');
const MESSAGES = new Set([
  "Evolution API nao configurada. Defina EVOLUTION_API_URL e EVOLUTION_API_KEY no servidor.",
  "Erro de autenticacao com a Evolution API. Verifique a chave no servidor.",
  "Evolution API esta offline ou indisponivel.",
  "Tempo limite excedido ao acessar a Evolution API.",
  "Evolution API recebeu muitas solicitacoes. Aguarde e tente novamente.",
  "Endpoint da Evolution API nao encontrado. Verifique a URL e a versao do servico.",
  "Nao foi possivel criar a instancia.",
  "Nao foi possivel gerar o codigo de conexao.",
  "Nao foi possivel concluir a solicitacao na Evolution API.",
  "Evolution API retornou uma resposta invalida. Verifique a URL e a inicializacao do servico.",
  "Nao foi possivel resolver o endereco da Evolution API.",
  "Evolution API esta offline ou inacessivel pela rede.",
  "Resposta de instancias incompativel com a Evolution API.",
  "Sua assinatura esta em atraso. Regularize o pagamento para continuar usando o sistema.",
  "Sua sessao expirou. Entre novamente no painel.",
  "Acesso da assinatura nao autorizado.",
  "Essa assinatura nao pertence a este login.",
  "Ja existe uma solicitacao de conexao em andamento. Aguarde sua conclusao.",
  "Nao foi possivel confirmar o estado da instancia do WhatsApp.",
  "Nenhuma sessao do WhatsApp foi iniciada ainda.",
  "Aguardando o codigo do WhatsApp. A recuperacao e limitada para evitar excesso de solicitacoes.",
  "Informe seu numero para gerar o codigo de conexao do WhatsApp.",
  "Existe uma conexao em andamento com outro numero. Desconecte antes de trocar o numero.",
  "Erro interno no servico do WhatsApp ao solicitar o codigo.",
  "Erro interno no servico do WhatsApp. Consulte os logs do servidor.",
  "Inicie uma conexao antes de recuperar o codigo.",
  "Numero invalido. Informe DDD e numero do WhatsApp.",
  "Numero de WhatsApp invalido. Informe DDD e numero.",
  "Nao foi possivel localizar a assinatura.",
  "Nao havia sessao ativa para desconectar.",
  "Existe uma tentativa de conexao em andamento. Aguarde antes de trocar o metodo ou numero.",
  "A instancia ja existe na Evolution API.",
  "WhatsApp ja esta desconectado.",
  "URL da Evolution API invalida. Configure o endereco base do servico.",
  "Aguarde a recuperacao em andamento antes de trocar o metodo.",
  "A instancia ainda tem uma tentativa com outro metodo. Aguarde ela terminar antes de trocar entre QR e codigo.",
  "A instancia ainda possui uma tentativa por QR Code. Aguarde ela terminar antes de gerar um codigo por telefone."
]);
const FALLBACK = 'Erro interno no servico. Tente novamente.';
function publicWhatsappError(error = {}) {
  const code = CODES.has(error?.code) ? error.code : 'WHATSAPP_INTERNAL_ERROR';
  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
  const message = MESSAGES.has(error?.message) ? error.message : FALLBACK;
  const result = { statusCode: code.startsWith('EVOLUTION_') && [401,403].includes(statusCode) ? 502 : statusCode, code, message };
  if (code === 'EVOLUTION_RATE_LIMIT') {
    if (['upstream','local_cooldown'].includes(error.rateLimitSource)) result.rateLimitSource = error.rateLimitSource;
    if (error.upstreamStatus === 429) result.upstreamStatus = 429;
    if (Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 86400) result.retryAfterSeconds = error.retryAfterSeconds;
    if (Number.isSafeInteger(error.retryAt) && error.retryAt >= Date.now() && error.retryAt <= Date.now()+86400000) result.retryAt = error.retryAt;
  }
  return result;
}
function safeWhatsappException(error) {
  const safe = publicWhatsappError(error);
  return Object.assign(new Error(safe.message), safe);
}
function logWhatsappFailure(error) {
  // Reuse the shared conservative logger; no raw Error, stack or cause reaches console.
  logEvolution('failure', { error: sanitize(publicWhatsappError(error)) }, 'error');
}
module.exports = { publicWhatsappError, safeWhatsappException, logWhatsappFailure };
