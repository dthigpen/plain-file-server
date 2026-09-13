const fs = require('fs');
const path = require('path');

let config = null;

function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  validateConfig(config);
  
  return config;
}

function validateConfig(cfg) {
  if (!cfg.server) {
    throw new Error('Missing server configuration');
  }
  
  if (typeof cfg.server.port !== 'number' || cfg.server.port < 1 || cfg.server.port > 65535) {
    throw new Error('Invalid server port');
  }
  
  if (!cfg.server.host || typeof cfg.server.host !== 'string') {
    throw new Error('Invalid server host');
  }
  
  if (!cfg.server.storageDir || typeof cfg.server.storageDir !== 'string') {
    throw new Error('Invalid storage directory');
  }
  
  if (!cfg.auth) {
    throw new Error('Missing auth configuration');
  }
  
  if (!cfg.auth.jwtSecret || typeof cfg.auth.jwtSecret !== 'string') {
    throw new Error('Invalid JWT secret');
  }
  
  if (cfg.auth.jwtSecret === 'REPLACE_WITH_A_SECURE_RANDOM_SECRET_KEY') {
    throw new Error('Please replace the default JWT secret with a secure random key');
  }
  
  if (!Array.isArray(cfg.auth.users) || cfg.auth.users.length === 0) {
    throw new Error('At least one user must be configured');
  }
  
  if (!cfg.rules) {
    throw new Error('Missing rules configuration');
  }
  
  if (!Array.isArray(cfg.rules.allowedExtensions)) {
    throw new Error('allowedExtensions must be an array');
  }
}

function getConfig() {
  if (!config) {
    return loadConfig();
  }
  return config;
}

module.exports = { getConfig, loadConfig };
