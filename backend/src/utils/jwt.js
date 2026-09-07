const jwt = require('jsonwebtoken');

const env = require('../config/env');

function signJwt(payload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function verifyJwt(token) {
  return jwt.verify(token, env.jwtSecret);
}

module.exports = {
  signJwt,
  verifyJwt,
};
