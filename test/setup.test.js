const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const test = require('node:test');
const bcrypt = require('bcryptjs');
const {
  configureRules,
  createSetupTemplate,
  isValidGrantPath,
  readExistingConfig,
  run
} = require('../scripts/setup');

function scriptedPrompt({ choices = [], lineAnswers = [], valueAnswers = [], confirmAnswers = [] } = {}) {
  const outputChunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      outputChunks.push(chunk.toString());
      callback();
    }
  });
  let choiceIndex = 0;
  let lineIndex = 0;
  let valueIndex = 0;
  let confirmIndex = 0;

  return {
    input: { isTTY: true },
    output,
    get outputText() {
      return outputChunks.join('');
    },
    async choose() {
      return choices[choiceIndex++];
    },
    async line(question) {
      const answer = lineAnswers[lineIndex++];
      return answer === undefined ? '' : answer;
    },
    async value(label, current) {
      return valueAnswers[valueIndex++] ?? current;
    },
    async passwordPair() {
      return bcrypt.hashSync('correct horse battery staple', 4);
    },
    async confirm() {
      return confirmAnswers[confirmIndex++] ?? true;
    }
  };
}

function temporaryConfigPath(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-file-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'config.json');
}

test('setup template requires initialization and grants a fresh JWT secret after bootstrap', t => {
  const configPath = temporaryConfigPath(t);
  fs.writeFileSync(configPath, JSON.stringify(createSetupTemplate()));
  const loaded = readExistingConfig(configPath);
  assert.equal(loaded.isNew, true);
  assert.notEqual(loaded.config.auth.jwtSecret, 'REPLACE_WITH_A_SECURE_RANDOM_SECRET_KEY');
  assert.ok(Buffer.from(loaded.config.auth.jwtSecret, 'base64url').length >= 32);
});

test('grant path input accepts only exact or recursive logical scopes', () => {
  for (const valid of ['/*', '/budget.txt', '/household/*', '/café/notes.txt']) {
    assert.equal(isValidGrantPath(valid), true, `${valid} should be accepted`);
  }
  for (const invalid of ['budget.txt', '/', '/foo/**', '/foo/bar*', '/foo/../bar', '/foo\\bar', '/foo/%2e%2e']) {
    assert.equal(isValidGrantPath(invalid), false, `${invalid} should be rejected`);
  }
});

test('setup extension policy maps to supported wildcard and extensionless settings', async () => {
  const policies = [
    [1, ['*']],
    [2, ['.*']],
    [4, []]
  ];
  for (const [selection, expected] of policies) {
    const config = createSetupTemplate();
    const prompt = scriptedPrompt({ choices: [selection] });
    await configureRules(config, prompt);
    assert.deepEqual(config.rules.allowedExtensions, expected);
  }
});

test('setup keeps explicit extension allowlists and permits replacing them', async () => {
  const config = createSetupTemplate();
  const prompt = scriptedPrompt({
    choices: [3],
    lineAnswers: ['.txt, .md']
  });
  await configureRules(config, prompt);
  assert.deepEqual(config.rules.allowedExtensions, ['.txt', '.md']);
});

test('initial wizard creates an admin and writes configuration with private permissions', async t => {
  const configPath = temporaryConfigPath(t);
  const prompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['wizard-admin'],
    confirmAnswers: [true]
  });

  assert.equal(await run(configPath, prompt), true);
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(bcrypt.compareSync('correct horse battery staple', written.auth.users[0].passwordHash), true);
  assert.equal(written.server.host, '127.0.0.1');
  assert.equal(written.auth.users[0].username, 'wizard-admin');
  assert.equal(written.auth.principals.admin.grants[0].path, '/*');
  assert.deepEqual(written.auth.principals.admin.grants[0].operations, ['read', 'write', 'delete', 'history']);
  assert.ok(Buffer.from(written.auth.jwtSecret, 'base64url').length >= 32);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.match(prompt.outputText, /generated secret hidden/);
  assert.doesNotMatch(prompt.outputText, new RegExp(written.auth.jwtSecret));
  assert.doesNotMatch(prompt.outputText, /correct horse battery staple/);
});

test('existing configuration can be edited and saved on a later run', async t => {
  const configPath = temporaryConfigPath(t);
  const firstPrompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['first-admin'],
    confirmAnswers: [true]
  });
  await run(configPath, firstPrompt);
  const before = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const editPrompt = scriptedPrompt({
    choices: [1, 6],
    valueAnswers: ['3141'],
    confirmAnswers: [true]
  });
  assert.equal(await run(configPath, editPrompt), true);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(after.server.port, 3141);
  assert.equal(after.auth.jwtSecret, before.auth.jwtSecret);
  assert.equal(after.auth.users[0].passwordHash, before.auth.users[0].passwordHash);
});

test('existing configuration can add a narrowly scoped integration user', async t => {
  const configPath = temporaryConfigPath(t);
  const initialPrompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['first-admin'],
    confirmAnswers: [true]
  });
  await run(configPath, initialPrompt);

  const addUserPrompt = scriptedPrompt({
    choices: [2, 1, 5, 6],
    lineAnswers: ['backup', 'backup-principal', '/notes/*', 'read,history'],
    confirmAnswers: [true]
  });
  await run(configPath, addUserPrompt);
  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(
    written.auth.users.map(user => user.username),
    ['first-admin', 'backup']
  );
  assert.deepEqual(written.auth.principals['backup-principal'].grants, [
    { path: '/notes/*', operations: ['read', 'history'] }
  ]);
});

test('rotating the signing secret replaces it without printing the secret', async t => {
  const configPath = temporaryConfigPath(t);
  const initialPrompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['first-admin'],
    confirmAnswers: [true]
  });
  await run(configPath, initialPrompt);
  const before = JSON.parse(fs.readFileSync(configPath, 'utf8')).auth.jwtSecret;

  const rotatePrompt = scriptedPrompt({
    choices: [5, 6],
    confirmAnswers: [true, true]
  });
  await run(configPath, rotatePrompt);
  const after = JSON.parse(fs.readFileSync(configPath, 'utf8')).auth.jwtSecret;
  assert.notEqual(after, before);
  assert.doesNotMatch(rotatePrompt.outputText, new RegExp(after));
});

test('canceling setup leaves an existing config unchanged', async t => {
  const configPath = temporaryConfigPath(t);
  const initialPrompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['first-admin'],
    confirmAnswers: [true]
  });
  await run(configPath, initialPrompt);
  const before = fs.readFileSync(configPath, 'utf8');

  const cancelPrompt = scriptedPrompt({ choices: [7] });
  assert.equal(await run(configPath, cancelPrompt), false);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});

test('canceling first-time setup does not write a configuration', async t => {
  const configPath = temporaryConfigPath(t);
  const prompt = scriptedPrompt({
    choices: [3, 7],
    lineAnswers: ['unused-admin'],
    confirmAnswers: [false]
  });
  assert.equal(await run(configPath, prompt), false);
  assert.equal(fs.existsSync(configPath), false);
});

test('setup refuses to prompt when stdin is not an interactive terminal', async t => {
  const configPath = temporaryConfigPath(t);
  const prompt = scriptedPrompt();
  prompt.input.isTTY = false;
  await assert.rejects(run(configPath, prompt), /interactive terminal/);
});

test('invalid edited settings do not replace the saved config', async t => {
  const configPath = temporaryConfigPath(t);
  const initialPrompt = scriptedPrompt({
    choices: [3, 6],
    lineAnswers: ['first-admin'],
    confirmAnswers: [true]
  });
  await run(configPath, initialPrompt);
  const before = fs.readFileSync(configPath, 'utf8');

  const invalidPrompt = scriptedPrompt({
    choices: [1, 6],
    valueAnswers: ['70000'],
    confirmAnswers: [true]
  });
  await assert.rejects(run(configPath, invalidPrompt), /Invalid server port/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
});
