const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadConfig } = require('../src/config');

function validConfig(root) {
  return {
    server: {
      port: 3000,
      host: '127.0.0.1',
      storageDir: path.join(root, 'documents')
    },
    auth: {
      jwtSecret: 'test-secret',
      tokenExpiryDays: 30,
      users: [{ username: 'test', passwordHash: 'bcrypt-hash' }],
      principals: {
        test: {
          grants: [{ path: '/*', operations: ['read', 'write', 'delete', 'history'] }]
        }
      }
    },
    rules: {
      allowedExtensions: ['.txt'],
      maxFileSizeMb: 1
    }
  };
}

test('configuration validates grant scopes, operations, and server limits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = validConfig(root);
  fs.writeFileSync(configPath, JSON.stringify(config));
  assert.equal(loadConfig(configPath).auth.principals.test.grants[0].path, '/*');

  const invalidCases = [
    [candidate => { candidate.auth.principals.test.grants[0].operations = ['execute']; }, /invalid grant/],
    [candidate => { candidate.auth.principals.test.grants[0].path = '/notes/**'; }, /invalid grant/],
    [candidate => { candidate.auth.principals.test.grants[0].path = '/notes/../private'; }, /invalid grant/],
    [candidate => { candidate.auth.users[0].principal = 'missing'; }, /unknown principal/],
    [candidate => { candidate.auth.tokenExpiryDays = 0; }, /tokenExpiryDays/],
    [candidate => { candidate.server.reconcileIntervalMs = 50; }, /reconcileIntervalMs/],
    [candidate => { candidate.server.historyDir = candidate.server.storageDir; }, /must be separate directories/],
    [candidate => { candidate.server.historyDir = path.join(candidate.server.storageDir, 'history'); }, /must be separate directories/],
    [candidate => { candidate.rules.maxFileSizeMb = 0; }, /maxFileSizeMb/],
    [candidate => { candidate.rules.allowedExtensions = ['.txt', 1]; }, /allowedExtensions/],
    [candidate => { candidate.rules.allowedExtensions = ['*', '.txt']; }, /allowedExtensions/],
    [candidate => { candidate.rules.allowedExtensions = ['.*', '.txt']; }, /allowedExtensions/],
    [candidate => { candidate.rules.allowedExtensions = ['.t*']; }, /allowedExtensions/],
    [candidate => { candidate.server.allowedOrigins = 'https://example.com'; }, /allowedOrigins/],
    [candidate => { candidate.server.allowedOrigins = ['https://example.com', 1]; }, /allowedOrigins/],
    [candidate => { candidate.server.allowedOrigins = ['']; }, /allowedOrigins/],
    [candidate => { candidate.server.allowedOrigins = ['*', 'https://example.com']; }, /allowedOrigins/],
    [candidate => { candidate.server.corsMaxAge = -1; }, /corsMaxAge/],
    [candidate => { candidate.server.corsMaxAge = 1.5; }, /corsMaxAge/],
    [candidate => { candidate.server.trustProxy = -1; }, /trustProxy/],
    [candidate => { candidate.server.trustProxy = {}; }, /trustProxy/],
    [candidate => { candidate.server.trustProxy = ['10.0.0.0/8', 5]; }, /trustProxy/]
  ];

  for (const [change, errorPattern] of invalidCases) {
    const invalidConfig = validConfig(root);
    change(invalidConfig);
    fs.writeFileSync(configPath, JSON.stringify(invalidConfig));
    assert.throws(() => loadConfig(configPath), errorPattern);
  }
});

test('configuration accepts CORS and trust-proxy options', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-config-cors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');

  const accepted = [
    { allowedOrigins: ['*'] },
    { allowedOrigins: [] },
    { allowedOrigins: ['https://app.example.com', 'https://host.tailnet.ts.net'] },
    { corsMaxAge: 0 },
    { trustProxy: true },
    { trustProxy: 1 },
    { trustProxy: 'loopback' },
    { trustProxy: ['loopback', '10.0.0.0/8'] }
  ];

  for (const serverOverrides of accepted) {
    const config = validConfig(root);
    Object.assign(config.server, serverOverrides);
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.doesNotThrow(() => loadConfig(configPath));
  }
});

test('configuration accepts the any-extension policies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-config-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  for (const allowedExtensions of [['*'], ['.*'], []]) {
    const config = validConfig(root);
    config.rules.allowedExtensions = allowedExtensions;
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.deepEqual(loadConfig(configPath).rules.allowedExtensions, allowedExtensions);
  }
});

test('configuration expands home-directory paths for storage and history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-config-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = validConfig(root);
  config.server.storageDir = '~/syncthing/household';
  config.server.historyDir = '~/syncthing/household-history';
  fs.writeFileSync(configPath, JSON.stringify(config));

  const loaded = loadConfig(configPath);
  assert.equal(
    loaded.server.storageDir,
    path.join(os.homedir(), 'syncthing', 'household')
  );
  assert.equal(
    loaded.server.historyDir,
    path.join(os.homedir(), 'syncthing', 'household-history')
  );
});

test('configuration rejects ambiguous tilde-prefixed directory paths', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-config-home-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  const config = validConfig(root);
  config.server.storageDir = '~other/data';
  fs.writeFileSync(configPath, JSON.stringify(config));

  assert.throws(() => loadConfig(configPath), /storageDir must use "~" or "~\/\.\.\."/);
});

test('corrupt persisted history metadata fails explicitly instead of resetting history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const historyDir = path.join(root, 'history');
  fs.mkdirSync(historyDir);
  fs.writeFileSync(path.join(historyDir, 'index.json'), '{"documents":');
  const config = validConfig(root);
  config.server.historyDir = historyDir;

  assert.throws(() => {
    const { FileService } = require('../src/services/fileService');
    new FileService(config);
  }, /Unable to load version history/);
});
