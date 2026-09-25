const { accessState } = require('./trial');
const TOLERANCIA_ATRASO_DIAS = 4;

function criarDataLocal(data) {
  if (!data) {
    return null;
  }

  const [ano, mes, dia] = String(data)
    .slice(0, 10)
    .split('-')
    .map((item) => Number.parseInt(item, 10));

  if (!ano || !mes || !dia) {
    return null;
  }

  return new Date(ano, mes - 1, dia);
}

function calcularDiferencaEmDias(dataInicial, dataFinal) {
  const inicio = new Date(dataInicial.getFullYear(), dataInicial.getMonth(), dataInicial.getDate());
  const fim = new Date(dataFinal.getFullYear(), dataFinal.getMonth(), dataFinal.getDate());
  return Math.round((fim.getTime() - inicio.getTime()) / (24 * 60 * 60 * 1000));
}

function acessoManualAtivo(assinatura) {
  return Date.parse(assinatura?.acesso_manual_ate || '') > Date.now();
}

function calcularResumoPagamento(assinatura) {
  if (acessoManualAtivo(assinatura)) {
    return {
      diasAtraso: 0, atrasado: false, venceHoje: false, bloqueiaHoje: false,
      bloqueado: false, statusSugerido: 'ativa', statusAssinaturaSugerido: 'ATIVA',
      indicadorAtraso: 'Acesso liberado pelo administrador',
      mensagemAdmin: 'Acesso temporario sem confirmacao de pagamento.',
      mensagemCliente: 'Seu acesso temporario esta liberado.',
    };
  }
  if (!assinatura?.proximo_vencimento) {
    return {
      diasAtraso: 0,
      atrasado: false,
      venceHoje: false,
      bloqueiaHoje: false,
      statusSugerido: assinatura?.status || 'pendente',
      statusAssinaturaSugerido: assinatura?.status_assinatura || 'PENDENTE',
      bloqueado: Number(assinatura?.bloqueado || 0) === 1,
      indicadorAtraso: 'Sem vencimento definido',
      mensagemAdmin: 'Sem vencimento definido.',
      mensagemCliente: 'Pagamento pendente. Conclua a assinatura para liberar o sistema.',
    };
  }

  const hoje = new Date();
  const vencimento = criarDataLocal(assinatura.proximo_vencimento);

  if (!vencimento) {
    return {
      diasAtraso: 0,
      atrasado: false,
      venceHoje: false,
      bloqueiaHoje: false,
      statusSugerido: assinatura.status,
      statusAssinaturaSugerido: assinatura.status_assinatura || 'PENDENTE',
      bloqueado: Number(assinatura?.bloqueado || 0) === 1,
      indicadorAtraso: 'Data invalida',
      mensagemAdmin: 'Data de vencimento invalida.',
      mensagemCliente: 'Nao foi possivel verificar o vencimento da assinatura.',
    };
  }

  const diasAtraso = Math.max(0, calcularDiferencaEmDias(vencimento, hoje));
  const diasParaVencer = calcularDiferencaEmDias(hoje, vencimento);
  const atrasado = diasAtraso > 0;
  const venceHoje = diasParaVencer === 0;
  const bloqueiaHoje = diasAtraso === TOLERANCIA_ATRASO_DIAS;
  const bloqueadoAutomatico = diasAtraso > TOLERANCIA_ATRASO_DIAS;
  const statusGateway = String(assinatura.gateway_status || '').toLowerCase();
  const cancelada = ['cancelled', 'canceled'].includes(statusGateway) || String(assinatura.status_assinatura || '').toUpperCase() === 'CANCELADA';

  let statusSugerido = assinatura.status;
  let statusAssinaturaSugerido = String(assinatura.status_assinatura || '').toUpperCase() || 'PENDENTE';
  let bloqueado = Number(assinatura.bloqueado || 0) === 1;

  if (cancelada) {
    statusSugerido = 'cancelada';
    statusAssinaturaSugerido = 'CANCELADA';
    bloqueado = true;
  } else if (String(assinatura.status || '').toLowerCase() === 'ativa' || String(assinatura.status || '').toLowerCase() === 'ativo') {
    if (bloqueadoAutomatico) {
      statusSugerido = 'bloqueada';
      statusAssinaturaSugerido = 'BLOQUEADA';
      bloqueado = true;
    } else if (atrasado || venceHoje) {
      statusSugerido = 'atrasada';
      statusAssinaturaSugerido = 'ATRASADA';
      bloqueado = false;
    } else {
      statusSugerido = 'ativa';
      statusAssinaturaSugerido = 'ATIVA';
      bloqueado = false;
    }
  } else if (bloqueadoAutomatico) {
    statusSugerido = 'bloqueada';
    statusAssinaturaSugerido = 'BLOQUEADA';
    bloqueado = true;
  }

  let indicadorAtraso = 'Em dia';
  let mensagemAdmin = 'Pagamento em dia.';
  let mensagemCliente = 'Seu acesso esta ativo.';

  if (cancelada) {
    indicadorAtraso = 'Cancelada';
    mensagemAdmin = 'Assinatura cancelada no Mercado Pago.';
    mensagemCliente = 'Sua assinatura foi cancelada. Regularize para voltar a usar o sistema.';
  } else if (bloqueadoAutomatico) {
    indicadorAtraso = `${diasAtraso} dias atrasado`;
    mensagemAdmin = `Pagamento atrasado ha ${diasAtraso} dias. O sistema deve permanecer bloqueado.`;
    mensagemCliente = 'Sua assinatura esta em atraso. Regularize o pagamento para voltar a usar o sistema.';
  } else if (bloqueiaHoje) {
    indicadorAtraso = '4 dias (bloquear hoje)';
    mensagemAdmin = 'Cliente no ultimo dia de tolerancia. Se o Mercado Pago nao aprovar, o bloqueio acontece hoje.';
    mensagemCliente = 'Sua assinatura esta no ultimo dia de tolerancia. Regularize hoje para evitar o bloqueio.';
  } else if (diasAtraso === 2) {
    indicadorAtraso = '2 dias atrasado';
    mensagemAdmin = 'Cliente com 2 dias de atraso.';
    mensagemCliente = 'Seu pagamento esta com 2 dias de atraso. Regularize para evitar bloqueio.';
  } else if (diasAtraso === 1) {
    indicadorAtraso = '1 dia atrasado';
    mensagemAdmin = 'Cliente com 1 dia de atraso.';
    mensagemCliente = 'Seu pagamento esta com 1 dia de atraso. Regularize para evitar bloqueio.';
  } else if (venceHoje) {
    indicadorAtraso = 'Vence hoje';
    mensagemAdmin = 'Pagamento vence hoje. Status deve ficar pendente ate a confirmacao do Mercado Pago.';
    mensagemCliente = 'Seu pagamento vence hoje.';
  } else if (diasParaVencer > 0 && diasParaVencer <= 3) {
    indicadorAtraso = `Vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}`;
    mensagemAdmin = `Pagamento vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}.`;
    mensagemCliente = `Seu pagamento vence em ${diasParaVencer} dia${diasParaVencer === 1 ? '' : 's'}.`;
  }

  return {
    diasAtraso,
    diasParaVencer,
    atrasado,
    venceHoje,
    bloqueiaHoje,
    bloqueadoAutomatico,
    statusSugerido,
    statusAssinaturaSugerido,
    bloqueado,
    indicadorAtraso,
    mensagemAdmin,
    mensagemCliente,
  };
}

function avaliarAcessoAssinatura(assinatura) {
  if (assinatura) {
    const resumo = calcularResumoPagamento(assinatura);
    assinatura = { ...assinatura, status: resumo.statusSugerido, bloqueado: resumo.bloqueado ? 1 : 0 };
  }
  return accessState(assinatura, avaliarAcessoPago(assinatura));
}

function avaliarAcessoPago(assinatura) {
  if (!assinatura) {
    return {
      liberado: false,
      motivo: 'nao_encontrada',
      mensagem: 'Assinatura nao encontrada.',
    };
  }

  const resumo = calcularResumoPagamento(assinatura);

  if (assinatura.bloqueado || assinatura.status === 'bloqueada' || assinatura.status === 'cancelada') {
    return {
      liberado: false,
      motivo: 'bloqueado',
      mensagem: resumo.mensagemCliente,
    };
  }

  if (assinatura.status === 'ativa' || assinatura.status === 'ativo') {
    return {
      liberado: true,
      motivo: 'assinatura_ativa',
      mensagem: 'Assinatura ativa.',
    };
  }

  if (assinatura.status === 'atrasada') {
    return {
      liberado: true,
      motivo: 'grace_period',
      mensagem: resumo.mensagemCliente,
    };
  }

  if (assinatura.status === 'teste' || assinatura.status === 'pendente' || assinatura.status === 'autorizada' || assinatura.status === 'pausada') {
    return {
      liberado: false,
      motivo: 'pagamento_pendente',
      mensagem: 'Cadastro concluido. Finalize a assinatura para liberar o sistema.',
    };
  }

  return {
    liberado: false,
    motivo: 'bloqueado',
    mensagem: resumo.mensagemCliente,
  };
}

module.exports = { criarDataLocal, calcularDiferencaEmDias, acessoManualAtivo, calcularResumoPagamento, avaliarAcessoAssinatura };
