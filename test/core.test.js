const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HttpError } = require('../src/errors');
const { isDocumentAllowed, pathRuleError } = require('../src/middleware/rules');
const { parseDocumentPath, resolveDocumentPath } = require('../src/services/documentPath');
const {
  FileService,
  atomicWrite,
  ifMatchSatisfied,
  ifNoneMatchSatisfied
} = require('../src/services/fileService');

function createFileService(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-core-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    server: {
      storageDir: path.join(root, 'documents'),
      historyDir: path.join(root, 'history')
    },
    rules: {
      ignoreDotfiles: true,
      allowedExtensions: ['.txt'],
      excludePatterns: [],
      readOnlyPatterns: []
    }
  };
  return { config, service: new FileService(config), root };
}

test('extension policies distinguish unrestricted, required, extensionless, and allowlisted names', () => {
  const cases = [
    { allowedExtensions: ['*'], accepted: ['notes', 'notes.txt', 'notes.exe'] },
    { allowedExtensions: ['.*'], accepted: ['notes.txt', 'notes.exe'], rejected: ['notes'] },
    { allowedExtensions: [], accepted: ['notes'], rejected: ['notes.txt'] },
    { allowedExtensions: ['.txt', '.md'], accepted: ['notes', 'notes.txt', 'notes.md'], rejected: ['notes.exe'] }
  ];

  for (const rules of cases) {
    for (const filename of rules.accepted) {
      assert.equal(isDocumentAllowed(filename, rules), true, `${JSON.stringify(rules.allowedExtensions)} accepts ${filename}`);
      assert.equal(pathRuleError(filename, rules), null);
    }
    for (const filename of rules.rejected || []) {
      assert.equal(isDocumentAllowed(filename, rules), false, `${JSON.stringify(rules.allowedExtensions)} rejects ${filename}`);
      assert.equal(pathRuleError(filename, rules).status, 415);
    }
  }
  assert.equal(pathRuleError('notes', cases[1]).message, 'A file extension is required');
  assert.equal(pathRuleError('notes.exe', cases[3]).message, 'File extension is not allowed');
});

test('document path parsing decodes components before rejecting traversal and encoded separators', () => {
  assert.equal(parseDocumentPath('notes/my%20file.txt'), 'notes/my file.txt');
  assert.equal(parseDocumentPath('caf%C3%A9/%E6%97%A5%E6%9C%AC%E8%AA%9E.txt'), 'café/日本語.txt');
  assert.equal(parseDocumentPath('literal%25name.txt'), 'literal%name.txt');

  for (const input of [
    '',
    '/absolute.txt',
    'notes//file.txt',
    '../secret.txt',
    'notes/%2e%2e/secret.txt',
    'notes/%2Fsecret.txt',
    'notes/%5csecret.txt',
    'notes/%ZZ.txt',
    'C%3A/secret.txt',
    'notes/%00file.txt'
  ]) {
    assert.throws(() => parseDocumentPath(input), error =>
      error instanceof HttpError && error.status === 400,
      `Expected ${input} to be rejected`
    );
  }

  if (process.platform === 'win32') {
    for (const input of ['CON.txt', 'name.', 'name ']) {
      assert.throws(() => parseDocumentPath(input), HttpError);
    }
  }
});

test('filesystem resolution blocks final and intermediate symlinks and rejects directories', t => {
  const { config, service, root } = createFileService(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  fs.mkdirSync(path.join(config.server.storageDir, 'real'));
  fs.writeFileSync(path.join(config.server.storageDir, 'real', 'file.txt'), 'inside');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(config.server.storageDir, 'link.txt'));
  fs.symlinkSync(outside, path.join(config.server.storageDir, 'linked'));

  assert.throws(() => service.pathFor('link.txt'), error => error.status === 403);
  assert.throws(() => service.pathFor('linked/secret.txt'), error => error.status === 403);
  assert.throws(() => service.getCurrent('real'), error => error.status === 400);
  assert.equal(
    resolveDocumentPath(config.server.storageDir, 'real/file.txt'),
    path.join(config.server.storageDir, 'real', 'file.txt')
  );
});

test('version lifecycle retains history through external change, deletion, recreation, and restart', t => {
  const { config, service } = createFileService(t);
  const contentPath = path.join(config.server.storageDir, 'doc.txt');

  const firstVersion = service.write('doc.txt', Buffer.from('one'));
  assert.equal(firstVersion.version, 1);
  assert.equal(service.write('doc.txt', Buffer.from('one'), service.getCurrent('doc.txt').version.etag).version, 1);
  fs.writeFileSync(contentPath, 'two');
  service.reconcile();
  service.reconcile();
  assert.deepEqual(service.getHistory('doc.txt').versions.map(version => version.version), [1, 2]);
  assert.equal(service.getVersion('doc.txt', 1).content.toString(), 'one');
  fs.writeFileSync(contentPath, 'three');
  service.reconcile();
  assert.deepEqual(service.getHistory('doc.txt').versions.map(version => version.version), [1, 2, 3]);
  assert.equal(service.getVersion('doc.txt', 2).content.toString(), 'two');

  fs.unlinkSync(contentPath);
  service.reconcile();
  assert.equal(service.getHistory('doc.txt').deleted, true);
  assert.throws(() => service.getCurrent('doc.txt'), error => error.status === 404);

  service.write('doc.txt', Buffer.from('four'));
  assert.equal(service.getCurrent('doc.txt').version.version, 4);

  const restarted = new FileService(config);
  restarted.reconcile();
  const restartedHistory = restarted.getHistory('doc.txt');
  assert.deepEqual(restartedHistory.versions.map(version => version.version), [1, 2, 3, 4]);
  assert.deepEqual(restartedHistory.versions.map(version => version.current), [false, false, false, true]);
  assert.equal(restartedHistory.versions[0].etag, firstVersion.etag);
  assert.equal(restarted.getVersion('doc.txt', 2).content.toString(), 'two');
});

test('periodic reconciliation skips unchanged file reads and versions changed files', t => {
  const { config, service } = createFileService(t);
  const contentPath = path.join(config.server.storageDir, 'doc.txt');
  service.write('doc.txt', Buffer.from('initial content'));
  service.reconcile();

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filePath, ...args) => {
    if (filePath === contentPath) {
      throw new Error('unchanged document should not be read during periodic reconciliation');
    }
    return originalReadFileSync(filePath, ...args);
  };
  try {
    service.reconcile();
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.deepEqual(service.getMetadata('doc.txt').versions.map(version => version.version), [1]);

  fs.writeFileSync(contentPath, 'changed external content');
  service.reconcile();
  assert.deepEqual(service.getMetadata('doc.txt').versions.map(version => version.version), [1, 2]);
  assert.equal(service.getVersion('doc.txt', 2).content.toString(), 'changed external content');
});

test('failed history snapshot leaves no false version and reconciliation recovers the file write', t => {
  const { config, service } = createFileService(t);
  service.write('doc.txt', Buffer.from('one'));

  const documentHash = crypto.createHash('sha256').update('doc.txt').digest('hex');
  const blockedVersionPath = path.join(config.server.historyDir, 'documents', documentHash, '2.txt');
  fs.mkdirSync(blockedVersionPath);

  assert.throws(() => service.write('doc.txt', Buffer.from('two'), service.getCurrent('doc.txt').version.etag));
  assert.equal(fs.readFileSync(path.join(config.server.storageDir, 'doc.txt'), 'utf8'), 'two');
  assert.deepEqual(service.getMetadata('doc.txt').versions.map(version => version.version), [1]);

  fs.rmdirSync(blockedVersionPath);
  assert.equal(service.getCurrent('doc.txt').version.version, 2);
  assert.equal(service.getVersion('doc.txt', 2).content.toString(), 'two');
});

test('atomic write failure preserves the prior destination and removes its temporary file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-atomic-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, 'file.txt');
  fs.writeFileSync(destination, 'original');

  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw new Error('simulated disk failure');
  };
  try {
    assert.throws(() => atomicWrite(destination, Buffer.from('partial')), /simulated disk failure/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(destination, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(root), ['file.txt']);
});

test('HTTP entity-tag comparison follows strong If-Match and weak If-None-Match rules', () => {
  const etag = '"tag"';
  assert.equal(ifMatchSatisfied(etag, etag, true), true);
  assert.equal(ifMatchSatisfied(`"other", ${etag}`, etag, true), true);
  assert.equal(ifMatchSatisfied(`W/${etag}`, etag, true), false);
  assert.equal(ifMatchSatisfied('*', etag, true), true);
  assert.equal(ifMatchSatisfied('*', null, false), false);
  assert.equal(ifNoneMatchSatisfied(`W/${etag}`, etag), true);
  assert.equal(ifNoneMatchSatisfied(`"other", ${etag}`, etag), true);
  assert.equal(ifNoneMatchSatisfied('*', etag), true);
  assert.equal(ifNoneMatchSatisfied('"other"', etag), false);
  assert.equal(ifNoneMatchSatisfied('"comma,inside", "other"', '"comma,inside"'), true);
  assert.equal(ifMatchSatisfied('"comma,inside", "other"', '"comma,inside"', true), true);
  assert.throws(() => ifMatchSatisfied('not-an-etag', etag, true), error => error.status === 400);
  assert.throws(() => ifMatchSatisfied('"unterminated', etag, true), error => error.status === 400);
  assert.throws(() => ifMatchSatisfied('*, "tag"', etag, true), error => error.status === 400);
});

test('history and storage directories may not overlap, including through symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actual-files-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storageDir = path.join(root, 'documents');
  fs.mkdirSync(storageDir);
  const linkedHistoryDir = path.join(root, 'history-link');
  fs.symlinkSync(storageDir, linkedHistoryDir);
  const config = {
    server: { storageDir, historyDir: linkedHistoryDir },
    rules: { allowedExtensions: [], excludePatterns: [], readOnlyPatterns: [] }
  };
  assert.throws(() => new FileService(config), /must be separate directories/);
});
