const express = require('express');
const rateLimit = require('express-rate-limit');
const { findUser, verifyPassword, generateToken } = require('../services/authService');
const { getConfig } = require('../config');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: { error: 'Too many login attempts, please try again later' }
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  const user = findUser(username);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  
  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  
  const token = generateToken(user);
  
  res.json({
    token,
    expiresInDays: getConfig().auth.tokenExpiryDays
  });
});

module.exports = router;
