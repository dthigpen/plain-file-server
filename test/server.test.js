const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src');
const { loadConfig } = require('../src/config');
const { FileService } = require('../src/services/fileService');

test('versioned document API reconciles files, guards paths, and authorizes operations', async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-file-server-'));
  const storageDir = path.join(temporaryRoot, 'documents');
  const historyDir = path.join(temporaryRoot, 'history');
  fs.mkdirSync(path.join(storageDir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'notes', 'today.txt'), 'initial');
  fs.chmodSync(path.join(storageDir, 'notes', 'today.txt'), 0o640);

  const secret = 'test-secret-that-is-long-enough';
  const configPath = path.join(temporaryRoot, 'config.json');
  const config = {
    server: { port: 3000, host: '127.0.0.1', storageDir, historyDir, reconcileIntervalMs: 1000 },
    auth: {
      jwtSecret: secret,
      tokenExpiryDays: 2,
      users: [
        { username: 'admin', principal: 'admin', passwordHash: bcrypt.hashSync('password', 4) },
        { username: 'reader', principal: 'reader', passwordHash: bcrypt.hashSync('password', 4) }
      ],
      principals: {
        admin: {
          grants: [{ path: '/*', operations: ['read', 'write', 'delete', 'history'] }]
        },
        reader: {
          grants: [{ path: '/notes/*', operations: ['read'] }]
        },
        exactReader: {
          grants: [{ path: '/notes/today.txt', operations: ['read'] }]
        },
        historyOnly: {
          grants: [{ path: '/notes/*', operations: ['history'] }]
        },
        deleteOnly: {
          grants: [{ path: '/notes/delete-me.txt', operations: ['delete'] }]
        },
        combined: {
          grants: [
            { path: '/notes/*', operations: ['history'] },
            { path: '/notes/today.txt', operations: ['read'] }
          ]
        }
      }
    },
    rules: {
      ignoreDotfiles: true,
      maxFileSizeMb: 1,
      allowedExtensions: ['.txt', '.md'],
      excludePatterns: ['**/private/**'],
      readOnlyPatterns: ['**/archive/**']
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  loadConfig(configPath);

  const fileService = new FileService(config);
  const app = createApp(config, fileService);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const versionedBaseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const tokenFor = principal => jwt.sign({ sub: principal }, secret);
  const login = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  });
  assert.equal(login.status, 200);
  const loginResult = await login.json();
  assert.equal(loginResult.expiresInDays, 2);
  const versionedLogin = await fetch(`${versionedBaseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password' })
  });
  assert.equal(versionedLogin.status, 200);
  assert.equal(typeof (await versionedLogin.json()).token, 'string');
  const wrongPassword = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' })
  });
  assert.equal(wrongPassword.status, 401);
  const adminHeaders = { Authorization: `Bearer ${loginResult.token}` };
  const readerHeaders = { Authorization: `Bearer ${tokenFor('reader')}` };
  const exactReaderHeaders = { Authorization: `Bearer ${tokenFor('exactReader')}` };
  const historyOnlyHeaders = { Authorization: `Bearer ${tokenFor('historyOnly')}` };
  const deleteOnlyHeaders = { Authorization: `Bearer ${tokenFor('deleteOnly')}` };
  const combinedHeaders = { Authorization: `Bearer ${tokenFor('combined')}` };
  const url = suffix => `${baseUrl}${suffix}`;
  const rawGet = requestPath => new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: `/api${requestPath}`,
      headers: adminHeaders
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });

  const initial = await fetch(url('/files/notes/today.txt'), { headers: adminHeaders });
  assert.equal(initial.status, 200);
  assert.equal(await initial.text(), 'initial');
  const initialEtag = initial.headers.get('etag');
  assert.ok(initialEtag);
  assert.equal(initial.headers.get('x-version'), '1');

  const versionedInitial = await fetch(
    `${versionedBaseUrl}/files/notes/today.txt`,
    { headers: adminHeaders }
  );
  assert.equal(versionedInitial.status, 200);
  assert.equal(await versionedInitial.text(), 'initial');
  assert.equal(versionedInitial.headers.get('etag'), initialEtag);

  const missingWriteCondition = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'missing condition'
  });
  assert.equal(missingWriteCondition.status, 428);
  const unchangedWrite = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': initialEtag },
    body: 'initial'
  });
  assert.equal(unchangedWrite.status, 200);
  assert.equal(unchangedWrite.headers.get('x-version'), '1');

  const head = await fetch(url('/files/notes/today.txt'), { method: 'HEAD', headers: adminHeaders });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('etag'), initialEtag);
  assert.equal(head.headers.get('x-version'), '1');
  assert.equal(await head.text(), '');
  const missingHead = await fetch(url('/files/notes/missing.txt'), { method: 'HEAD', headers: adminHeaders });
  assert.equal(missingHead.status, 404);

  const notModified = await fetch(url('/files/notes/today.txt'), {
    headers: { ...adminHeaders, 'If-None-Match': initialEtag }
  });
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  const weakNotModified = await fetch(url('/files/notes/today.txt'), {
    headers: { ...adminHeaders, 'If-None-Match': `W/${initialEtag}` }
  });
  assert.equal(weakNotModified.status, 304);
  const anyNotModified = await fetch(url('/files/notes/today.txt'), {
    headers: { ...adminHeaders, 'If-None-Match': '*' }
  });
  assert.equal(anyNotModified.status, 304);
  const invalidIfNoneMatch = await fetch(url('/files/notes/today.txt'), {
    headers: { ...adminHeaders, 'If-None-Match': 'not-an-etag' }
  });
  assert.equal(invalidIfNoneMatch.status, 400);

  const weakWriteCondition = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': `W/${initialEtag}` },
    body: 'weak tags do not satisfy If-Match'
  });
  assert.equal(weakWriteCondition.status, 412);

  const updated = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'application/json', 'If-Match': initialEtag },
    body: JSON.stringify({ content: 'updated' })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).version, 2);
  assert.equal(fs.statSync(path.join(storageDir, 'notes', 'today.txt')).mode & 0o777, 0o640);
  const secondEtag = updated.headers.get('etag');
  assert.notEqual(secondEtag, initialEtag);
  assert.equal(fs.readFileSync(path.join(storageDir, 'notes', 'today.txt'), 'utf8'), 'updated');

  const multiTagUpdate = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': `"unrelated", ${secondEtag}` },
    body: 'updated'
  });
  assert.equal(multiTagUpdate.status, 200);
  assert.equal(multiTagUpdate.headers.get('x-version'), '2');
  const wildcardUpdate = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': '*' },
    body: 'updated'
  });
  assert.equal(wildcardUpdate.status, 200);
  assert.equal(wildcardUpdate.headers.get('x-version'), '2');

  const stale = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': initialEtag },
    body: 'stale'
  });
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).serverContent, 'updated');
  const malformedIfMatch = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': '"unfinished' },
    body: 'should remain unchanged'
  });
  assert.equal(malformedIfMatch.status, 400);

  const history = await fetch(url('/files/notes/today.txt/history'), { headers: adminHeaders });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json()).versions.map(item => item.version), [1, 2]);
  assert.deepEqual((await (await fetch(url('/files/notes/today.txt/history'), { headers: adminHeaders })).json())
    .versions.map(item => item.current), [false, true]);

  const oldVersion = await fetch(url('/files/notes/today.txt/versions/1'), { headers: adminHeaders });
  assert.equal(await oldVersion.text(), 'initial');
  assert.equal(oldVersion.headers.get('etag'), initialEtag);
  const historicalNotModified = await fetch(url('/files/notes/today.txt/versions/1'), {
    headers: { ...adminHeaders, 'If-None-Match': initialEtag }
  });
  assert.equal(historicalNotModified.status, 304);
  const malformedVersion = await fetch(url('/files/notes/today.txt/versions/not-a-number'), { headers: adminHeaders });
  assert.equal(malformedVersion.status, 400);

  fs.writeFileSync(path.join(storageDir, 'notes', 'today.txt'), 'external');
  const historyAfterExternalChange = await fetch(url('/files/notes/today.txt/history'), { headers: adminHeaders });
  assert.deepEqual((await historyAfterExternalChange.json()).versions.map(item => item.version), [1, 2, 3]);
  fileService.reconcile();
  fileService.reconcile();
  const external = await fetch(url('/files/notes/today.txt'), { headers: adminHeaders });
  assert.equal(await external.text(), 'external');
  assert.equal(external.headers.get('x-version'), '3');
  fs.writeFileSync(path.join(storageDir, 'external-new.txt'), 'new external file');
  const newlyDiscovered = await fetch(url('/files/external-new.txt'), { headers: adminHeaders });
  assert.equal(await newlyDiscovered.text(), 'new external file');
  assert.equal(newlyDiscovered.headers.get('x-version'), '1');
  const restartedService = new FileService(config);
  restartedService.reconcile();
  assert.deepEqual(restartedService.getHistory('notes/today.txt').versions.map(item => item.version), [1, 2, 3]);

  const readerGet = await fetch(url('/files/notes/today.txt'), { headers: readerHeaders });
  assert.equal(readerGet.status, 200);
  const readerWrite = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...readerHeaders, 'Content-Type': 'text/plain' },
    body: 'denied'
  });
  assert.equal(readerWrite.status, 403);
  const readerHistory = await fetch(url('/files/notes/today.txt/history'), { headers: readerHeaders });
  assert.equal(readerHistory.status, 403);
  const readerHead = await fetch(url('/files/notes/today.txt'), { method: 'HEAD', headers: readerHeaders });
  assert.equal(readerHead.status, 200);
  const historyOnlyHistory = await fetch(url('/files/notes/today.txt/history'), { headers: historyOnlyHeaders });
  assert.equal(historyOnlyHistory.status, 200);
  const historyOnlyVersion = await fetch(url('/files/notes/today.txt/versions/1'), { headers: historyOnlyHeaders });
  assert.equal(historyOnlyVersion.status, 200);
  const historyOnlyCurrent = await fetch(url('/files/notes/today.txt'), { headers: historyOnlyHeaders });
  assert.equal(historyOnlyCurrent.status, 403);
  const combinedRead = await fetch(url('/files/notes/today.txt'), { headers: combinedHeaders });
  assert.equal(combinedRead.status, 200);
  const combinedHistory = await fetch(url('/files/notes/today.txt/history'), { headers: combinedHeaders });
  assert.equal(combinedHistory.status, 200);
  const combinedOtherRead = await fetch(url('/files/notes/my%20file.txt'), { headers: combinedHeaders });
  assert.equal(combinedOtherRead.status, 403);
  const readerDelete = await fetch(url('/files/notes/today.txt'), {
    method: 'DELETE',
    headers: readerHeaders
  });
  assert.equal(readerDelete.status, 403);
  const readerListResponse = await fetch(url('/files'), { headers: readerHeaders });
  const readerList = (await readerListResponse.json()).files;
  assert.ok(readerList.includes('notes/today.txt'));
  assert.ok(!readerList.includes('__proto__'));
  const exactRead = await fetch(url('/files/notes/today.txt'), { headers: exactReaderHeaders });
  assert.equal(exactRead.status, 200);
  const exactScopeDenied = await fetch(url('/files/notes/my%20file.txt'), { headers: exactReaderHeaders });
  assert.equal(exactScopeDenied.status, 403);
  const unauthenticated = await fetch(url('/files/notes/today.txt'));
  assert.equal(unauthenticated.status, 401);
  const invalidToken = await fetch(url('/files/notes/today.txt'), {
    headers: { Authorization: 'Bearer invalid.token.value' }
  });
  assert.equal(invalidToken.status, 401);

  const createdPath = '/files/notes/my%20file.txt';
  const created = await fetch(url(createdPath), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'space'
  });
  assert.equal(created.status, 200);
  assert.equal(fs.readFileSync(path.join(storageDir, 'notes', 'my file.txt'), 'utf8'), 'space');

  const failedCreateCondition = await fetch(url('/files/notes/conditional.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain', 'If-Match': '*' },
    body: 'must not create'
  });
  assert.equal(failedCreateCondition.status, 412);
  const unicode = await fetch(url('/files/notes/caf%C3%A9.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'unicode'
  });
  assert.equal(unicode.status, 200);
  assert.equal(fs.readFileSync(path.join(storageDir, 'notes', 'café.txt'), 'utf8'), 'unicode');
  const reservedName = await fetch(url('/files/notes/%68istory'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'ordinary document'
  });
  assert.equal(reservedName.status, 200);
  assert.equal(fs.readFileSync(path.join(storageDir, 'notes', 'history'), 'utf8'), 'ordinary document');
  const specialName = await fetch(url('/files/__proto__'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'ordinary extensionless document'
  });
  assert.equal(specialName.status, 200);
  const specialHistory = await fetch(url('/files/__proto__/history'), { headers: adminHeaders });
  assert.equal(specialHistory.status, 200);
  const reservedVersionsName = await fetch(url('/files/notes/%76ersions/1'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'reserved route name'
  });
  assert.equal(reservedVersionsName.status, 200);
  const readReservedVersionsName = await fetch(url('/files/notes/%76ersions/1'), { headers: adminHeaders });
  assert.equal(await readReservedVersionsName.text(), 'reserved route name');
  assert.equal((new URL(url('/files/notes/my%20file.txt?mode=read'))).pathname, '/api/files/notes/my%20file.txt');
  const queryStringRead = await fetch(url('/files/notes/my%20file.txt?mode=read'), { headers: adminHeaders });
  assert.equal(await queryStringRead.text(), 'space');

  const directory = await fetch(url('/files/notes'), { headers: adminHeaders });
  assert.equal(directory.status, 400);
  const unsupportedExtension = await fetch(url('/files/notes/file.exe'), { headers: adminHeaders });
  assert.equal(unsupportedExtension.status, 415);
  const excludedPath = await fetch(url('/files/private/file.txt'), { headers: adminHeaders });
  assert.equal(excludedPath.status, 403);
  const dotfile = await fetch(url('/files/notes/.hidden.txt'), { headers: adminHeaders });
  assert.equal(dotfile.status, 403);
  const readOnlyWrite = await fetch(url('/files/archive/file.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'read only'
  });
  assert.equal(readOnlyWrite.status, 403);
  const malformedJson = await fetch(url('/files/notes/bad.json'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(malformedJson.status, 400);
  const missingContent = await fetch(url('/files/notes/missing-content.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 12 })
  });
  assert.equal(missingContent.status, 400);
  const emptyContent = await fetch(url('/files/notes/empty.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: ''
  });
  assert.equal(emptyContent.status, 200);
  assert.equal(emptyContent.headers.get('x-version'), '1');
  const emptyRead = await fetch(url('/files/notes/empty.txt'), { headers: adminHeaders });
  assert.equal(await emptyRead.text(), '');
  assert.equal(emptyRead.headers.get('content-length'), '0');
  const oneMegabyte = 'a'.repeat(1024 * 1024);
  const maximumSizeWrite = await fetch(url('/files/notes/max-size.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: oneMegabyte
  });
  assert.equal(maximumSizeWrite.status, 200);
  const excessiveWrite = await fetch(url('/files/notes/too-large.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: `${oneMegabyte}a`
  });
  assert.equal(excessiveWrite.status, 413);
  assert.equal(fs.existsSync(path.join(storageDir, 'notes', 'too-large.txt')), false);

  for (const unsafePath of [
    '/files/%2e%2e/secret.txt',
    '/files/notes/%2e%2e/%2e%2e/secret.txt',
    '/files/%2Fetc/passwd',
    '/files//etc/passwd',
    '/files/C:%5csecret.txt',
    '/files/notes%2Ftoday.txt',
    '/files/..%5csecret.txt',
    '/files/%ZZ.txt'
  ]) {
    const status = await rawGet(unsafePath);
    assert.ok(status === 400 || status === 403, `${unsafePath} returned ${status}`);
    const historyStatus = await rawGet(`${unsafePath}/history`);
    assert.ok(historyStatus === 400 || historyStatus === 403, `${unsafePath}/history returned ${historyStatus}`);
    const versionStatus = await rawGet(`${unsafePath}/versions/1`);
    assert.ok(versionStatus === 400 || versionStatus === 403, `${unsafePath}/versions/1 returned ${versionStatus}`);
  }

  const outsideFile = path.join(temporaryRoot, 'outside.txt');
  fs.writeFileSync(outsideFile, 'private');
  fs.symlinkSync(outsideFile, path.join(storageDir, 'notes', 'link.txt'));
  fs.mkdirSync(path.join(temporaryRoot, 'outside-dir'));
  fs.writeFileSync(path.join(temporaryRoot, 'outside-dir', 'secret.txt'), 'private');
  fs.symlinkSync(path.join(temporaryRoot, 'outside-dir'), path.join(storageDir, 'linked-dir'));
  const symlinkRequest = await fetch(url('/files/notes/link.txt'), { headers: adminHeaders });
  assert.equal(symlinkRequest.status, 403);
  const intermediateSymlinkRequest = await fetch(url('/files/linked-dir/secret.txt'), { headers: adminHeaders });
  assert.equal(intermediateSymlinkRequest.status, 403);

  const deleteResponse = await fetch(url('/files/notes/today.txt'), {
    method: 'DELETE',
    headers: { ...adminHeaders, 'If-Match': initialEtag }
  });
  assert.equal(deleteResponse.status, 412);
  const stillCurrentAfterStaleDelete = await fetch(url('/files/notes/today.txt'), { headers: adminHeaders });
  assert.equal(stillCurrentAfterStaleDelete.status, 200);
  const successfulDelete = await fetch(url('/files/notes/today.txt'), {
    method: 'DELETE',
    headers: { ...adminHeaders, 'If-Match': external.headers.get('etag') }
  });
  assert.equal(successfulDelete.status, 200);
  const deletedVersion = await fetch(url('/files/notes/today.txt/versions/3'), { headers: adminHeaders });
  assert.equal(await deletedVersion.text(), 'external');
  const deletedRead = await fetch(url('/files/notes/today.txt'), { headers: adminHeaders });
  assert.equal(deletedRead.status, 404);
  const retainedHistory = await fetch(url('/files/notes/today.txt/history'), { headers: adminHeaders });
  assert.equal(retainedHistory.status, 200);
  assert.equal((await retainedHistory.json()).deleted, true);

  const recreation = await fetch(url('/files/notes/today.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'external'
  });
  assert.equal(recreation.status, 200);
  assert.equal(recreation.headers.get('x-version'), '4');

  const externallyDeleted = await fetch(url('/files/external-delete.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'before external delete'
  });
  assert.equal(externallyDeleted.status, 200);
  fs.unlinkSync(path.join(storageDir, 'external-delete.txt'));
  fileService.reconcile();
  const externalDeletionHistory = await fetch(url('/files/external-delete.txt/history'), { headers: adminHeaders });
  assert.equal((await externalDeletionHistory.json()).deleted, true);

  const deleteOnlyCreate = await fetch(url('/files/notes/delete-me.txt'), {
    method: 'PUT',
    headers: { ...adminHeaders, 'Content-Type': 'text/plain' },
    body: 'target'
  });
  assert.equal(deleteOnlyCreate.status, 200);
  const deleteOnlyRead = await fetch(url('/files/notes/delete-me.txt'), { headers: deleteOnlyHeaders });
  assert.equal(deleteOnlyRead.status, 403);
  const deleteOnlyWrite = await fetch(url('/files/notes/delete-me.txt'), {
    method: 'PUT',
    headers: { ...deleteOnlyHeaders, 'Content-Type': 'text/plain', 'If-Match': deleteOnlyCreate.headers.get('etag') },
    body: 'not allowed'
  });
  assert.equal(deleteOnlyWrite.status, 403);
  const deleteOnlyResult = await fetch(url('/files/notes/delete-me.txt'), {
    method: 'DELETE',
    headers: { ...deleteOnlyHeaders, 'If-Match': deleteOnlyCreate.headers.get('etag') }
  });
  assert.equal(deleteOnlyResult.status, 200);
});

test('extension policies consistently filter listings and guard reads and writes', async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-file-extensions-'));
  const storageDir = path.join(temporaryRoot, 'documents');
  const historyDir = path.join(temporaryRoot, 'history');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'extensionless'), 'no extension');
  fs.writeFileSync(path.join(storageDir, 'allowed.txt'), 'text');
  fs.writeFileSync(path.join(storageDir, 'other.bin'), 'binary');
  const secret = 'test-extension-secret';
  const configPath = path.join(temporaryRoot, 'config.json');
  const config = {
    server: { port: 3000, host: '127.0.0.1', storageDir, historyDir },
    auth: {
      jwtSecret: secret,
      tokenExpiryDays: 2,
      users: [{ username: 'admin', passwordHash: bcrypt.hashSync('password', 4) }],
      principals: {
        admin: { grants: [{ path: '/*', operations: ['read', 'write', 'delete', 'history'] }] }
      }
    },
    rules: {
      ignoreDotfiles: true,
      maxFileSizeMb: 1,
      allowedExtensions: ['*'],
      excludePatterns: [],
      readOnlyPatterns: []
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const runtimeConfig = loadConfig(configPath);
  const fileService = new FileService(runtimeConfig);
  const server = createApp(runtimeConfig, fileService).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const headers = { Authorization: `Bearer ${jwt.sign({ sub: 'admin' }, secret)}` };
  const policies = [
    { extensions: ['*'], listed: ['allowed.txt', 'extensionless', 'other.bin'], extensionless: 200, binary: 200 },
    { extensions: ['.*'], listed: ['allowed.txt', 'other.bin'], extensionless: 415, binary: 200 },
    { extensions: [], listed: ['extensionless'], extensionless: 200, binary: 415 },
    { extensions: ['.txt'], listed: ['allowed.txt', 'extensionless'], extensionless: 200, binary: 415 }
  ];

  for (const [index, policy] of policies.entries()) {
    runtimeConfig.rules.allowedExtensions = policy.extensions;
    const listing = await fetch(`${baseUrl}/files`, { headers });
    assert.equal(listing.status, 200);
    const listedFiles = (await listing.json()).files;
    assert.deepEqual(
      listedFiles.filter(filename => ['allowed.txt', 'extensionless', 'other.bin'].includes(filename)),
      policy.listed
    );
    assert.ok(listedFiles.every(filename => {
      const extension = path.posix.extname(filename);
      return policy.extensions.includes('*') ||
        (policy.extensions.includes('.*') && Boolean(extension)) ||
        (!extension || policy.extensions.includes(extension));
    }));

    const extensionlessRead = await fetch(`${baseUrl}/files/extensionless`, { headers });
    assert.equal(extensionlessRead.status, policy.extensionless);
    const binaryRead = await fetch(`${baseUrl}/files/other.bin`, { headers });
    assert.equal(binaryRead.status, policy.binary);

    const extensionlessWrite = await fetch(`${baseUrl}/files/new-${index}`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: 'new extensionless file'
    });
    assert.equal(extensionlessWrite.status, policy.extensionless === 200 ? 200 : 415);
    const binaryWrite = await fetch(`${baseUrl}/files/new-${index}.bin`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'text/plain' },
      body: 'new binary file'
    });
    assert.equal(binaryWrite.status, policy.binary);
  }
});
