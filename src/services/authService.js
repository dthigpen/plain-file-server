const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getConfig } = require('../config');

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  const config = getConfig();
  const payload = {
    username: user.username,
    role: user.role,
    allowedSubdirs: user.allowedSubdirs
  };
  
  const expiresIn = `${config.auth.tokenExpiryDays}d`;
  
  return jwt.sign(payload, config.auth.jwtSecret, { expiresIn });
}

function verifyToken(token) {
  const config = getConfig();
  
  try {
    return jwt.verify(token, config.auth.jwtSecret);
  } catch (error) {
    return null;
  }
}

function findUser(username) {
  const config = getConfig();
  return config.auth.users.find(user => user.username === username);
}

module.exports = {
  verifyPassword,
  generateToken,
  verifyToken,
  findUser
};
