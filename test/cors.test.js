const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const { createApp, corsOriginOption } = require('../src');
const { FileService } = require('../src/services/fileService');

function resolveOrigin(option, origin) {
  if (typeof option === 'function') {
    return new Promise((resolve, reject) => {
      option(origin, (error, allowed) => (error ? reject(error) : resolve(allowed)));
    });
  }
  return option;
}

test('corsOriginOption maps config to cors origin behavior', async () => {
  assert.equal(corsOriginOption(undefined), true);
  assert.equal(corsOriginOption(['*']), true);
  assert.equal(corsOriginOption([]), false);

  const option = corsOriginOption(['https://app.example.com']);
  assert.equal(typeof option, 'function');
  assert.equal(await resolveOrigin(option, 'https://app.example.com'), true);
  assert.equal(await resolveOrigin(option, 'https://evil.example.com'), false);
  // Same-origin / non-browser requests omit the Origin header.
  assert.equal(await resolveOrigin(option, undefined), true);
});

function buildApp(serverOverrides, t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-file-cors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    server: {
      port: 3000,
      host: '127.0.0.1',
      storageDir: path.join(root, 'documents'),
      historyDir: path.join(root, 'history'),
      reconcileIntervalMs: 1000,
      ...serverOverrides
    },
    auth: {
      jwtSecret: 'test-secret-that-is-long-enough',
      tokenExpiryDays: 2,
      users: [{ username: 'admin', principal: 'admin', passwordHash: bcrypt.hashSync('password', 4) }],
      principals: {
        admin: { grants: [{ path: '/*', operations: ['read', 'write', 'delete', 'history'] }] }
      }
    },
    rules: { ignoreDotfiles: true, maxFileSizeMb: 1, allowedExtensions: ['.txt'] }
  };
  return createApp(config, new FileService(config));
}

async function listen(app, t) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('an allowlist only echoes approved origins', async t => {
  const app = buildApp({ allowedOrigins: ['https://app.example.com'], corsMaxAge: 123 }, t);
  const baseUrl = await listen(app, t);

  const approved = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://app.example.com' }
  });
  assert.equal(approved.headers.get('access-control-allow-origin'), 'https://app.example.com');

  const rejected = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://evil.example.com' }
  });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);

  const preflight = await fetch(`${baseUrl}/api/v1/files/notes.txt`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://app.example.com',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'If-Match'
    }
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(preflight.headers.get('access-control-max-age'), '123');
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /If-Match/i);
});

test('an empty allowlist blocks cross-origin requests', async t => {
  const app = buildApp({ allowedOrigins: [] }, t);
  const baseUrl = await listen(app, t);
  const response = await fetch(`${baseUrl}/health`, {
    headers: { Origin: 'https://app.example.com' }
  });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.status, 200);
});

test('trust proxy enables X-Forwarded-For client addresses', async t => {
  const app = buildApp({ trustProxy: true }, t);
  app.get('/client-ip', (req, res) => res.json({ ip: req.ip }));
  const baseUrl = await listen(app, t);
  const response = await fetch(`${baseUrl}/client-ip`, {
    headers: { 'X-Forwarded-For': '203.0.113.7' }
  });
  assert.equal((await response.json()).ip, '203.0.113.7');
});
