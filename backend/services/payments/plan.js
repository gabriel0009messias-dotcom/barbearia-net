const PROFESSIONAL_PLAN = Object.freeze({
  code: 'plano-profissional-mensal',
  name: 'Plano Profissional',
  amountCents: 6500,
  currency: 'BRL',
  durationDays: 30,
});

// valor_mensal is the stored contract price, including protected older contracts.
function subscriptionPlan(subscription) {
  return {
    ...PROFESSIONAL_PLAN,
    name: subscription.plano || PROFESSIONAL_PLAN.name,
    amountCents: Math.round(Number(subscription.valor_mensal) * 100),
  };
}

module.exports = { PROFESSIONAL_PLAN, subscriptionPlan };
