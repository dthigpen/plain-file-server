const fs = require('fs');
const os = require('os');
const path = require('path');

let config = null;

function loadConfig(configPath = path.join(process.cwd(), 'config.json')) {
  
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}; run npm run setup to create it`);
  }

  const configData = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configData);
  
  validateConfig(config);
  
  return config;
}

function resolveConfiguredDirectory(directory, name) {
  if (directory === '~') {
    return path.resolve(os.homedir());
  }
  if (directory.startsWith('~/')) {
    return path.resolve(os.homedir(), directory.slice(2));
  }
  if (directory.startsWith('~')) {
    throw new Error(`${name} must use "~" or "~/..." for a home-directory path`);
  }
  return path.resolve(directory);
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
  if (cfg.server.historyDir !== undefined && typeof cfg.server.historyDir !== 'string') {
    throw new Error('Invalid history directory');
  }
  const storageDir = resolveConfiguredDirectory(cfg.server.storageDir, 'storageDir');
  const historyDir = cfg.server.historyDir
    ? resolveConfiguredDirectory(cfg.server.historyDir, 'historyDir')
    : path.resolve(`${storageDir}.history`);
  cfg.server.storageDir = storageDir;
  if (cfg.server.historyDir) {
    cfg.server.historyDir = historyDir;
  }
  const storageToHistory = path.relative(storageDir, historyDir);
  const historyToStorage = path.relative(historyDir, storageDir);
  const storageContainsHistory = storageToHistory === '' ||
    (storageToHistory !== '..' &&
      !storageToHistory.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(storageToHistory));
  const historyContainsStorage = historyToStorage === '' ||
    (historyToStorage !== '..' &&
      !historyToStorage.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(historyToStorage));
  if (
    storageContainsHistory ||
    historyContainsStorage
  ) {
    throw new Error('historyDir and storageDir must be separate directories');
  }
  if (
    cfg.server.reconcileIntervalMs !== undefined &&
    (!Number.isInteger(cfg.server.reconcileIntervalMs) || cfg.server.reconcileIntervalMs < 100)
  ) {
    throw new Error('reconcileIntervalMs must be an integer of at least 100');
  }
  
  if (!cfg.auth) {
    throw new Error('Missing auth configuration');
  }
  
  if (!cfg.auth.jwtSecret || typeof cfg.auth.jwtSecret !== 'string') {
    throw new Error('Invalid JWT secret');
  }
  
  if (cfg.auth.jwtSecret === 'REPLACE_WITH_A_SECURE_RANDOM_SECRET_KEY') {
    throw new Error('Configuration is not initialized; run npm run setup to create credentials and a JWT secret');
  }
  
  if (!Array.isArray(cfg.auth.users) || cfg.auth.users.length === 0) {
    throw new Error('At least one user must be configured');
  }
  if (cfg.auth.users.some(user =>
    !user ||
    typeof user.username !== 'string' ||
    !user.username ||
    typeof user.passwordHash !== 'string' ||
    (user.principal !== undefined && typeof user.principal !== 'string') ||
    (user.allowedSubdirs !== undefined &&
      (!Array.isArray(user.allowedSubdirs) || user.allowedSubdirs.some(scope => typeof scope !== 'string')))
  )) {
    throw new Error('Each user must define a username and passwordHash');
  }

  if (!Number.isInteger(cfg.auth.tokenExpiryDays) || cfg.auth.tokenExpiryDays < 1) {
    throw new Error('tokenExpiryDays must be a positive integer');
  }

  const hasConfiguredPrincipals = cfg.auth.principals !== undefined;
  if (hasConfiguredPrincipals) {
    if (!cfg.auth.principals || typeof cfg.auth.principals !== 'object' || Array.isArray(cfg.auth.principals)) {
      throw new Error('auth.principals must be an object');
    }
    cfg.auth.principals = Object.assign(Object.create(null), cfg.auth.principals);
    const allowedOperations = new Set(['read', 'write', 'delete', 'history']);
    for (const [principalId, principal] of Object.entries(cfg.auth.principals)) {
      if (!principalId || !principal || !Array.isArray(principal.grants)) {
        throw new Error(`Principal "${principalId}" must define grants`);
      }
      for (const grant of principal.grants) {
        const wildcardPrefix = typeof grant.path === 'string' && grant.path.endsWith('/*')
          ? grant.path.slice(0, -2)
          : '';
        const grantPath = typeof grant.path === 'string' ? grant.path : '';
        const grantSegments = grantPath === '/*'
          ? []
          : grantPath.slice(1, grantPath.endsWith('/*') ? -2 : undefined).split('/');
        if (
          !grantPath.startsWith('/') ||
          (grantPath.includes('*') && (!grantPath.endsWith('/*') || wildcardPrefix.includes('*'))) ||
          grantSegments.some(segment =>
            !segment || segment === '.' || segment === '..' ||
            segment.includes('\\') || /^[a-zA-Z]:/.test(segment)
          ) ||
          !Array.isArray(grant.operations) ||
          grant.operations.some(operation => !allowedOperations.has(operation))
        ) {
          throw new Error(`Principal "${principalId}" has an invalid grant`);
        }
      }
    }
  }
  cfg.auth.principals ||= Object.create(null);
  for (const user of cfg.auth.users) {
    const principalId = user.principal || user.username;
    if (user.principal && hasConfiguredPrincipals && !Object.hasOwn(cfg.auth.principals, principalId)) {
      throw new Error(`User "${user.username}" references an unknown principal`);
    }
    if (!Object.hasOwn(cfg.auth.principals, principalId)) {
      const scopes = user.allowedSubdirs === undefined ? ['*'] : user.allowedSubdirs;
      cfg.auth.principals[principalId] = {
        grants: scopes.map(scope => ({
          path: scope === '*' ? '/*' : `/${scope.replace(/^\/+/, '').replace(/\/$/, '')}/*`,
          operations: ['read', 'write', 'delete', 'history']
        }))
      };
    }
  }
  
  if (!cfg.rules) {
    throw new Error('Missing rules configuration');
  }
  
  if (!Array.isArray(cfg.rules.allowedExtensions)) {
    throw new Error('allowedExtensions must be an array');
  }
  if (cfg.rules.allowedExtensions.some(extension => typeof extension !== 'string')) {
    throw new Error('allowedExtensions must contain strings');
  }
  if (
    (cfg.rules.allowedExtensions.includes('*') && cfg.rules.allowedExtensions.length !== 1) ||
    (cfg.rules.allowedExtensions.includes('.*') && cfg.rules.allowedExtensions.length !== 1) ||
    cfg.rules.allowedExtensions.some(extension =>
      extension !== '*' && extension !== '.*' && extension.includes('*')
    )
  ) {
    throw new Error('allowedExtensions must use "*" or ".*" alone, or list specific extensions');
  }
  if (cfg.rules.ignoreDotfiles !== undefined && typeof cfg.rules.ignoreDotfiles !== 'boolean') {
    throw new Error('ignoreDotfiles must be a boolean');
  }

  if (!Number.isInteger(cfg.rules.maxFileSizeMb) || cfg.rules.maxFileSizeMb < 1) {
    throw new Error('maxFileSizeMb must be a positive integer');
  }
  cfg.rules.excludePatterns ||= [];
  cfg.rules.readOnlyPatterns ||= [];
  if (
    !Array.isArray(cfg.rules.excludePatterns) ||
    cfg.rules.excludePatterns.some(pattern => typeof pattern !== 'string') ||
    !Array.isArray(cfg.rules.readOnlyPatterns) ||
    cfg.rules.readOnlyPatterns.some(pattern => typeof pattern !== 'string')
  ) {
    throw new Error('excludePatterns and readOnlyPatterns must be arrays of strings');
  }
}

function getConfig() {
  if (!config) {
    return loadConfig();
  }
  return config;
}

module.exports = { getConfig, loadConfig, validateConfig };
