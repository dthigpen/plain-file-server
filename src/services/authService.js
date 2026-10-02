const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function principalForUser(user, config = getConfig()) {
  const principalId = user.principal || user.username;
  const configuredPrincipal = config.auth.principals && Object.hasOwn(config.auth.principals, principalId)
    ? config.auth.principals[principalId]
    : undefined;
  if (configuredPrincipal) {
    return { id: principalId, grants: configuredPrincipal.grants };
  }

  const legacyScopes = user.allowedSubdirs === undefined ? ['*'] : user.allowedSubdirs;
  return {
    id: principalId,
    grants: legacyScopes.map(scope => ({
      path: scope === '*' ? '/*' : `/${String(scope).replace(/^\/+/, '').replace(/\/$/, '')}/*`,
      operations: ['read', 'write', 'delete', 'history']
    }))
  };
}

function generateToken(user) {
  const config = getConfig();
  const principal = principalForUser(user, config);
  return jwt.sign(
    { sub: principal.id },
    config.auth.jwtSecret,
    { expiresIn: `${config.auth.tokenExpiryDays}d` }
  );
}

function verifyToken(token) {
  const config = getConfig();
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return null;
  }
}

function findUser(username) {
  return getConfig().auth.users.find(user => user.username === username);
}

module.exports = { verifyPassword, generateToken, verifyToken, findUser, principalForUser };
