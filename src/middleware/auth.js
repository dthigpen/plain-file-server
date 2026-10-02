const { principalForUser, verifyToken } = require('../services/authService');
const { getConfig } = require('../config');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  
  req.principalId = decoded.sub || decoded.username;
  const config = getConfig();
  const configuredPrincipal = config.auth.principals && Object.hasOwn(config.auth.principals, req.principalId)
    ? config.auth.principals[req.principalId]
    : undefined;
  const user = config.auth.users.find(candidate =>
    (candidate.principal || candidate.username) === req.principalId
  );
  if (!configuredPrincipal && !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.grants = configuredPrincipal?.grants ||
    principalForUser(user, config).grants;
  next();
}

module.exports = { authenticate };
