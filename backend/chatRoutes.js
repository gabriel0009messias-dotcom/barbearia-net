const express = require('express');
const rateLimit = require('express-rate-limit');
const { createChat, SESSION_SECONDS } = require('./services/chat');

module.exports = function chatRoutes(db, requireBarbeiro) {
  const router = express.Router(), chat = createChat(db);
  const secure = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  const cookieName = secure ? '__Secure-studiofy_chat' : 'studiofy_chat';
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      if (error.statusCode === 429) res.set('Retry-After', '60');
      res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Não foi possível concluir a operação do chat.' });
    }
  };
  const limiter = (limit, windowMs, keyGenerator) => rateLimit({
    limit, windowMs, standardHeaders: 'draft-7', legacyHeaders: false,
    validate: { trustProxy: false }, ...(keyGenerator ? { keyGenerator } : {}),
    message: { error: 'Muitas solicitações ao chat. Aguarde antes de tentar novamente.' },
  });
  // Closest forwarded address, not the attacker-controlled leftmost X-Forwarded-For entry.
  const ip = req => req.ips?.at(-1) || req.ip;
  const reads = limiter(120, 60000, ip);
  const creation = limiter(5, 15 * 60000, ip);
  const sending = limiter(30, 60000, ip);
  const ownerReads = limiter(120, 60000, req => String(req.assinatura.id));
  const ownerWrites = limiter(60, 60000, req => String(req.assinatura.id));
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  function sameOrigin(req, res, next) {
    const configured = process.env.PUBLIC_APP_URL || process.env.RENDER_EXTERNAL_URL;
    let expected;
    try { expected = new URL(configured || (!secure ? `${req.protocol}://${req.get('host')}` : '')).origin; }
    catch { return res.status(503).json({ error: 'Origem pública do chat não configurada.' }); }
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expected)) return res.status(403).json({ error: 'Origem não permitida.' });
    if (req.method !== 'GET' && (origin !== expected || req.get('x-studiofy-chat') !== '1' || !req.is('application/json'))) {
      return res.status(403).json({ error: 'Requisição de chat inválida.' });
    }
    next();
  }
  function actor(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(p => p.trim().split('='));
    const candidates = cookies.filter(([name]) => name === cookieName);
    return { slug: req.params.slug, token: candidates.length === 1 ? candidates[0][1] : null };
  }
  router.use('/public/:slug', (req, res, next) => {
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(req.params.slug)) return res.status(404).json({ error: 'Chat indisponível.' });
    next();
  }, sameOrigin);
  router.post('/public/:slug/session', creation, wrap(async (req, res) => {
    const result = await chat.start(actor(req), req.body);
    if (result.token) res.cookie(cookieName, result.token, { httpOnly: true, secure, sameSite: 'strict',
      path: `/api/chat/public/${req.params.slug}`, maxAge: SESSION_SECONDS * 1000 });
    res.status(result.created ? 201 : 200).json({ conversation: result.conversation });
  }));
  router.get('/public/:slug/messages', reads, wrap(async (req, res) => res.json(await chat.history(actor(req), 'customer', req.query))));
  router.post('/public/:slug/messages', sending, wrap(async (req, res) => {
    const result = await chat.send(actor(req), 'customer', req.body);
    res.status(result.created ? 201 : 200).json({ message: result.message });
  }));
  router.post('/public/:slug/read', reads, wrap(async (req, res) => res.json(await chat.read(actor(req), 'customer', req.body))));
  router.use('/conversations', requireBarbeiro);
  const owner = req => ({ tenantId: req.assinatura.id, conversationId: req.params.id });
  router.get('/conversations', ownerReads, wrap(async (req, res) => res.json(await chat.inbox(req.assinatura.id, req.query))));
  router.get('/conversations/unread', ownerReads, wrap(async (req, res) => res.json(await chat.unread(req.assinatura.id))));
  router.post('/conversations/search', ownerReads, wrap(async (req, res) => res.json(await chat.searchInbox(req.assinatura.id, req.body))));
  router.get('/conversations/:id/messages', ownerReads, wrap(async (req, res) => res.json(await chat.history(owner(req), 'establishment', req.query))));
  router.post('/conversations/:id/messages', ownerWrites, wrap(async (req, res) => {
    const result = await chat.send(owner(req), 'establishment', req.body);
    res.status(result.created ? 201 : 200).json({ message: result.message });
  }));
  router.post('/conversations/:id/read', ownerReads, wrap(async (req, res) => res.json(await chat.read(owner(req), 'establishment', req.body))));
  return router;
};
