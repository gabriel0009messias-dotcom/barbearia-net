const { verifyJwt } = require('../utils/jwt');
const userRepository = require('../repositories/userRepository');
const saasUserRepository = require('../repositories/saasUserRepository');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [, token] = header.split(' ');

    if (!token) {
      res.status(401).json({ error: 'Token nao informado.' });
      return;
    }

    const payload = verifyJwt(token);
    const user = (await saasUserRepository.findById(payload.sub)) || (await userRepository.findById(payload.sub));

    const activeFlag = user?.ativo === undefined ? true : user.ativo;

    if (!user || !activeFlag) {
      res.status(401).json({ error: 'Sessao invalida.' });
      return;
    }

    req.auth = payload;
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Sessao invalida.' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    const userRole = req.user?.papel || req.user?.role;

    if (!req.user || userRole !== role) {
      res.status(403).json({ error: 'Acesso negado.' });
      return;
    }

    next();
  };
}

function requireRoles(...roles) {
  return (req, res, next) => {
    const userRole = req.user?.papel || req.user?.role;

    if (!req.user || !roles.includes(userRole)) {
      res.status(403).json({ error: 'Acesso negado.' });
      return;
    }

    next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
  requireRoles,
};
