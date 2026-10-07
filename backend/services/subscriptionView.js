// Only scalar presentation fields may leave the subscription record.
// Authentication material and provider payloads never belong in this DTO.
const SUBSCRIPTION_FIELDS = Object.freeze([
  'id', 'barbearia_nome', 'responsavel_nome', 'telefone', 'email',
  'metodo_pagamento', 'dia_vencimento', 'valor_mensal', 'status',
  'suporte_numero', 'ultimo_pagamento', 'proximo_vencimento', 'observacoes',
  'whatsapp_numero', 'whatsapp_status', 'whatsapp_session',
  'whatsapp_ultimo_erro', 'whatsapp_ultimo_check_em', 'whatsapp_ultimo_qr_em',
  'created_at', 'updated_at', 'trial_usado', 'trial_started_at', 'trial_expires_at',
  'trial_ends_at', 'trial_status', 'trial', 'horario_abertura',
  'horario_almoco_inicio', 'horario_almoco_fim', 'horario_fechamento',
  'localizacao_cidade', 'localizacao_rua', 'localizacao_referencia',
  'plano', 'valor_plano', 'status_assinatura', 'subscription_id', 'customer_id',
  'payment_id', 'dias_atraso', 'bloqueado', 'data_bloqueio', 'data_vencimento',
  'acesso_manual_ate', 'business_type_code', 'state_code',
  'instagram_handle', 'public_slug', 'page_description', 'page_color',
  'cover_image', 'logo_image', 'cancellation_notice_minutes',
  'gateway_provider', 'gateway_status', 'gateway_checkout_url',
  'mercado_preapproval_id', 'mercado_next_payment_date',
]);

function subscriptionView(row) {
  const result = {};
  for (const key of SUBSCRIPTION_FIELDS) {
    const value = row?.[key];
    if (!Object.hasOwn(row || {}, key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      result[key] = value;
    } else if (value instanceof Date && Number.isFinite(value.getTime())) {
      result[key] = value.toISOString();
    }
  }
  return result;
}

module.exports = { SUBSCRIPTION_FIELDS, subscriptionView };
