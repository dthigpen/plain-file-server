#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const { validateConfig } = require('../src/config');

const DEFAULT_EXTENSIONS = ['.txt', '.md', '.org', '.json', '.csv', '.log', '.yaml', '.yml'];
const OPERATIONS = ['read', 'write', 'delete', 'history'];
const SETUP_SECRET = 'REPLACE_WITH_A_SECURE_RANDOM_SECRET_KEY';

function createDefaultConfig() {
  return {
    server: {
      port: 3000,
      host: '127.0.0.1',
      storageDir: './storage',
      historyDir: './storage-history',
      reconcileIntervalMs: 60000,
      allowedOrigins: ['*'],
      trustProxy: false
    },
    auth: {
      jwtSecret: crypto.randomBytes(48).toString('base64url'),
      tokenExpiryDays: 30,
      users: [],
      principals: {}
    },
    rules: {
      ignoreDotfiles: true,
      maxFileSizeMb: 10,
      allowedExtensions: [...DEFAULT_EXTENSIONS],
      excludePatterns: ['**/node_modules/**', '**/.git/**', '**/.sync/**', '**/private/**'],
      readOnlyPatterns: ['**/archive/**', '**/templates/**']
    }
  };
}

function createSetupTemplate() {
  const config = createDefaultConfig();
  config.auth.jwtSecret = SETUP_SECRET;
  return config;
}

function readExistingConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return { config: createDefaultConfig(), isNew: true };
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${configPath}: ${error.message}`);
  }

  const needsInitialSetup =
    !config.auth ||
    config.auth.jwtSecret === SETUP_SECRET ||
    !Array.isArray(config.auth.users) ||
    config.auth.users.length === 0;
  if (needsInitialSetup) {
    const defaults = createDefaultConfig();
    return {
      config: {
        ...defaults,
        ...config,
        server: { ...defaults.server, ...config.server },
        auth: {
          ...defaults.auth,
          ...config.auth,
          jwtSecret: defaults.auth.jwtSecret,
          users: Array.isArray(config.auth?.users) ? config.auth.users : [],
          principals: config.auth?.principals || {}
        },
        rules: { ...defaults.rules, ...config.rules }
      },
      isNew: true
    };
  }

  return { config, isNew: false };
}

function parseCommaSeparated(value) {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function isValidGrantPath(grantPath) {
  if (typeof grantPath !== 'string' || !grantPath.startsWith('/')) {
    return false;
  }
  const wildcard = grantPath.endsWith('/*');
  const body = grantPath.slice(1, wildcard ? -2 : undefined);
  if (grantPath.includes('*') && (!wildcard || body.includes('*'))) {
    return false;
  }
  if (grantPath === '/*') {
    return true;
  }
  return body.split('/').every(segment =>
    segment &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\\') &&
    !segment.includes('%') &&
    !/^[a-zA-Z]:/.test(segment)
  );
}

function redactConfig(config) {
  return {
    ...config,
    auth: {
      ...config.auth,
      jwtSecret: '<generated secret hidden>',
      users: config.auth.users.map(user => ({ ...user, passwordHash: '<stored securely>' }))
    }
  };
}

function saveConfig(configPath, config) {
  validateConfig(config);
  const destination = path.resolve(configPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(destination),
    `.actual-files-config-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw cleanupError;
      }
    }
    throw new Error(`Could not save configuration to ${destination}: ${error.message}`);
  }
}

class ConsolePrompter {
  constructor(input = process.stdin, output = process.stdout) {
    this.input = input;
    this.output = output;
  }

  line(question) {
    const rl = readline.createInterface({ input: this.input, output: this.output });
    return new Promise((resolve, reject) => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer);
      });
      rl.once('SIGINT', () => {
        rl.close();
        reject(new Error('Setup cancelled'));
      });
    });
  }

  async value(label, current, validate = () => null) {
    while (true) {
      const answer = await this.line(`${label} [${current}]: `);
      if (answer === '') {
        return current;
      }
      const error = validate(answer);
      if (!error) {
        return answer;
      }
      this.output.write(`${error}\n`);
    }
  }

  async secret(label) {
    if (!this.input.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error('Password entry requires an interactive terminal; run npm run setup in a terminal.');
    }

    this.output.write(`${label} (input hidden): `);
    this.input.setRawMode(true);
    this.input.resume();
    readline.emitKeypressEvents(this.input);

    return new Promise((resolve, reject) => {
      let result = '';
      const finish = (error, value) => {
        this.input.removeListener('keypress', onKeypress);
        this.input.setRawMode(false);
        this.output.write('\n');
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const onKeypress = (character, key = {}) => {
        if (key.ctrl && key.name === 'c') {
          finish(new Error('Setup cancelled'));
        } else if (key.name === 'return' || key.name === 'enter') {
          finish(null, result);
        } else if (key.name === 'backspace' || key.name === 'delete') {
          result = result.slice(0, -1);
        } else if (key.ctrl && key.name === 'd') {
          finish(new Error('Setup cancelled'));
        } else if (character && !/[\u0000-\u001f\u007f]/.test(character)) {
          result += character;
        }
      };
      this.input.on('keypress', onKeypress);
    });
  }

  async passwordPair(label) {
    while (true) {
      const password = await this.secret(label);
      if (password.length < 12) {
        this.output.write('Use a password with at least 12 characters.\n');
        continue;
      }
      if (Buffer.byteLength(password, 'utf8') > 72) {
        this.output.write('Bcrypt passwords must be no more than 72 UTF-8 bytes.\n');
        continue;
      }
      const confirmation = await this.secret('Confirm password');
      if (password !== confirmation) {
        this.output.write('Passwords did not match. Try again.\n');
        continue;
      }
      return bcrypt.hashSync(password, 10);
    }
  }

  async choose(label, choices) {
    this.output.write(`${label}\n`);
    choices.forEach((choice, index) => this.output.write(`  ${index + 1}. ${choice}\n`));
    while (true) {
      const answer = (await this.line('Select an option: ')).trim();
      const selection = Number(answer);
      if (Number.isInteger(selection) && selection >= 1 && selection <= choices.length) {
        return selection;
      }
      this.output.write(`Choose a number from 1 to ${choices.length}.\n`);
    }
  }

  async confirm(message, defaultValue = false) {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
      const answer = (await this.line(`${message} (${hint}): `)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      if (['y', 'yes'].includes(answer)) {
        return true;
      }
      if (['n', 'no'].includes(answer)) {
        return false;
      }
      this.output.write('Please answer yes or no.\n');
    }
  }
}

async function configureServer(config, prompt) {
  const server = config.server;
  server.port = Number(await prompt.value('HTTP port', server.port, value =>
    /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535
      ? null
      : 'Enter a port from 1 to 65535.'
  ));
  server.host = await prompt.value('Bind address', server.host, value =>
    value.trim() ? null : 'Bind address cannot be empty.'
  );
  server.storageDir = await prompt.value('Document storage directory', server.storageDir, value =>
    value.trim() ? null : 'Storage directory cannot be empty.'
  );
  server.historyDir = await prompt.value('Version history directory', server.historyDir, value =>
    value.trim() ? null : 'History directory cannot be empty.'
  );
  server.reconcileIntervalMs = Number(await prompt.value(
    'Filesystem reconciliation interval in milliseconds',
    server.reconcileIntervalMs,
    value => /^\d+$/.test(value) && Number(value) >= 100
      ? null
      : 'Enter an integer of at least 100 milliseconds.'
  ));

  const originsDefault = Array.isArray(server.allowedOrigins) && !server.allowedOrigins.includes('*')
    ? server.allowedOrigins.join(', ')
    : '';
  const originsInput = await prompt.value(
    'Allowed browser origins, comma-separated (blank = allow any origin)',
    originsDefault,
    value => parseOriginList(value).some(origin => origin.includes('*'))
      ? 'Origins must be exact (no wildcards); leave blank to allow any origin.'
      : null
  );
  const origins = parseOriginList(originsInput);
  server.allowedOrigins = origins.length ? origins : ['*'];

  server.trustProxy = parseTrustProxy(await prompt.value(
    'Trust proxy for client IP and rate limiting (false, true, loopback, a hop count, or a comma-separated list)',
    trustProxyToInput(server.trustProxy),
    () => null
  ));
}

function parseOriginList(value) {
  return String(value)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function trustProxyToInput(value) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value === undefined ? 'false' : String(value);
}

function parseTrustProxy(value) {
  const text = String(value).trim();
  if (text === '' || text.toLowerCase() === 'false') {
    return false;
  }
  if (text.toLowerCase() === 'true') {
    return true;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const list = parseOriginList(text);
  if (list.length === 0) {
    return false;
  }
  return list.length === 1 ? list[0] : list;
}

async function addUser(config, prompt) {
  const username = (await prompt.line('Login username: ')).trim();
  if (!username || config.auth.users.some(user => user.username === username)) {
    throw new Error('Username must be non-empty and unique.');
  }
  const principalId = (await prompt.line(`Principal identifier [${username}]: `)).trim() || username;
  if (!principalId || !/^[A-Za-z0-9._-]+$/.test(principalId)) {
    throw new Error('Principal identifiers may contain letters, numbers, dots, underscores, and hyphens.');
  }
  if (Object.hasOwn(config.auth.principals, principalId)) {
    throw new Error(`Principal "${principalId}" already exists.`);
  }
  const passwordHash = await prompt.passwordPair('New password (12 characters minimum)');
  const scope = (await prompt.line('Initial grant path [/*]: ')).trim() || '/*';
  if (!isValidGrantPath(scope)) {
    throw new Error('Grant path must be an exact /path, /subtree/*, or /*.');
  }
  const operationInput = (await prompt.line(
    `Operations (${OPERATIONS.join(', ')}) [${OPERATIONS.join(',')}]: `
  )).trim();
  const operations = operationInput ? parseCommaSeparated(operationInput) : [...OPERATIONS];
  if (operations.length === 0 || operations.some(operation => !OPERATIONS.includes(operation))) {
    throw new Error(`Choose one or more of: ${OPERATIONS.join(', ')}.`);
  }

  config.auth.users.push({ username, passwordHash, principal: principalId });
  config.auth.principals[principalId] = {
    grants: [{ path: scope, operations }]
  };
}

async function editPrincipalGrants(config, principalId, prompt) {
  const principal = config.auth.principals[principalId];
  while (true) {
    prompt.output.write(`\nGrants for principal "${principalId}":\n`);
    if (principal.grants.length === 0) {
      prompt.output.write('  (none)\n');
    } else {
      principal.grants.forEach((grant, index) => {
        prompt.output.write(`  ${index + 1}. ${grant.path}: ${grant.operations.join(', ')}\n`);
      });
    }
    const action = await prompt.choose('Grant actions:', [
      'Add a grant',
      'Remove a grant',
      'Return to users'
    ]);
    if (action === 1) {
      const grantPath = (await prompt.line('Grant path (/file.txt, /folder/*, or /*): ')).trim();
      if (!isValidGrantPath(grantPath)) {
        prompt.output.write('Invalid grant path.\n');
        continue;
      }
      const input = (await prompt.line(`Operations (${OPERATIONS.join(', ')}): `)).trim();
      const operations = parseCommaSeparated(input);
      if (!operations.length || operations.some(operation => !OPERATIONS.includes(operation))) {
        prompt.output.write(`Choose one or more of: ${OPERATIONS.join(', ')}.\n`);
        continue;
      }
      principal.grants.push({ path: grantPath, operations });
    } else if (action === 2) {
      if (!principal.grants.length) {
        prompt.output.write('There are no grants to remove.\n');
        continue;
      }
      const selected = await prompt.choose(
        'Select a grant to remove:',
        [...principal.grants.map(grant => `${grant.path}: ${grant.operations.join(', ')}`), 'Cancel']
      );
      if (selected <= principal.grants.length) {
        principal.grants.splice(selected - 1, 1);
      }
    } else {
      return;
    }
  }
}

async function manageUsers(config, prompt) {
  while (true) {
    prompt.output.write('\nConfigured login users:\n');
    config.auth.users.forEach((user, index) => {
      prompt.output.write(`  ${index + 1}. ${user.username} -> ${user.principal || user.username}\n`);
    });
    const selected = await prompt.choose('User actions:', [
      'Add login user',
      'Change a user password',
      'Edit a user principal grants',
      'Remove a login user',
      'Return to main menu'
    ]);
    if (selected === 1) {
      try {
        await addUser(config, prompt);
      } catch (error) {
        if (error.message === 'Setup cancelled') {
          throw error;
        }
        prompt.output.write(`${error.message}\n`);
      }
    } else if (selected === 2 || selected === 3 || selected === 4) {
      if (!config.auth.users.length) {
        prompt.output.write('There are no configured users.\n');
        continue;
      }
      const userSelection = await prompt.choose(
        'Select a login user:',
        [...config.auth.users.map(user => `${user.username} -> ${user.principal || user.username}`), 'Cancel']
      );
      if (userSelection > config.auth.users.length) {
        continue;
      }
      const user = config.auth.users[userSelection - 1];
      if (selected === 2) {
        user.passwordHash = await prompt.passwordPair(`New password for ${user.username}`);
      } else if (selected === 3) {
        const principalId = user.principal || user.username;
        if (!Object.hasOwn(config.auth.principals, principalId)) {
          prompt.output.write(`Principal "${principalId}" is not configured.\n`);
          continue;
        }
        await editPrincipalGrants(config, principalId, prompt);
      } else {
        if (config.auth.users.length === 1) {
          prompt.output.write('At least one login user must remain configured.\n');
          continue;
        }
        if (await prompt.confirm(`Remove login user "${user.username}"?`)) {
          config.auth.users.splice(userSelection - 1, 1);
          const principalId = user.principal || user.username;
          if (!config.auth.users.some(candidate => (candidate.principal || candidate.username) === principalId)) {
            delete config.auth.principals[principalId];
          }
        }
      }
    } else {
      return;
    }
  }
}

async function configureRules(config, prompt) {
  const rules = config.rules;
  const ignoreDotfiles = await prompt.value(
    'Ignore dotfiles? (yes/no)',
    rules.ignoreDotfiles ? 'yes' : 'no',
    value => ['yes', 'no'].includes(value.toLowerCase()) ? null : 'Enter yes or no.'
  );
  rules.ignoreDotfiles = ignoreDotfiles.toLowerCase() === 'yes';
  rules.maxFileSizeMb = Number(await prompt.value('Maximum write size in MiB', rules.maxFileSizeMb, value =>
    /^\d+$/.test(value) && Number(value) >= 1 ? null : 'Enter a positive integer.'
  ));

  const extensionPolicy = rules.allowedExtensions.includes('*')
    ? 'any'
    : rules.allowedExtensions.includes('.*')
      ? 'any-with-extension'
      : rules.allowedExtensions.length === 0
        ? 'extensionless-only'
        : 'specific';
  const selectedExtensionPolicy = await prompt.choose(
    `File extension policy (current: ${extensionPolicy}):`,
    [
      'Allow any filename, with or without an extension',
      'Allow any filename that has an extension',
      'Allow extensionless names and selected extensions',
      'Allow extensionless names only'
    ]
  );
  if (selectedExtensionPolicy === 1) {
    rules.allowedExtensions = ['*'];
  } else if (selectedExtensionPolicy === 2) {
    rules.allowedExtensions = ['.*'];
  } else if (selectedExtensionPolicy === 4) {
    rules.allowedExtensions = [];
  } else {
    const current = extensionPolicy === 'specific'
      ? rules.allowedExtensions.join(', ')
      : DEFAULT_EXTENSIONS.join(', ');
    while (true) {
      const value = await prompt.line(`Allowed extensions (comma-separated, e.g. .txt, .md) [${current}]: `);
      if (value === '') {
        if (extensionPolicy === 'specific') {
          break;
        }
        rules.allowedExtensions = [...DEFAULT_EXTENSIONS];
        break;
      }
      const extensions = parseCommaSeparated(value);
      if (
        extensions.length > 0 &&
        extensions.every(extension => extension.startsWith('.') && extension.length > 1 && !extension.includes('*'))
      ) {
        rules.allowedExtensions = extensions;
        break;
      }
      prompt.output.write('Enter extensions beginning with a dot, or press Enter to use the defaults.\n');
    }
  }

  for (const [key, label] of [
    ['excludePatterns', 'Glob patterns to exclude (comma-separated)'],
    ['readOnlyPatterns', 'Read-only glob patterns (comma-separated)']
  ]) {
    const current = rules[key].join(', ');
    const value = await prompt.line(`${label} [${current}]: `);
    if (value !== '') {
      rules[key] = parseCommaSeparated(value);
    }
  }
}

async function configureAuthentication(config, prompt) {
  config.auth.tokenExpiryDays = Number(await prompt.value(
    'JWT token lifetime in days',
    config.auth.tokenExpiryDays,
    value => /^\d+$/.test(value) && Number(value) >= 1 ? null : 'Enter a positive integer.'
  ));
}

async function initialSetup(config, prompt) {
  prompt.output.write('Welcome. This wizard creates a local admin account and a fresh JWT signing secret.\n');
  await configureServer(config, prompt);
  await configureAuthentication(config, prompt);
  if (config.auth.users.length === 0) {
    const username = (await prompt.line('Admin login username [admin]: ')).trim() || 'admin';
    if (!username) {
      throw new Error('Username cannot be empty.');
    }
    const passwordHash = await prompt.passwordPair('Admin password (12 characters minimum)');
    config.auth.users = [{ username, principal: 'admin', passwordHash }];
    config.auth.principals = {
      admin: { grants: [{ path: '/*', operations: [...OPERATIONS] }] }
    };
  }
  await configureRules(config, prompt);
}

async function mainMenu(config, prompt, isNew) {
  let dirty = isNew;
  while (true) {
    prompt.output.write('\n');
    const selected = await prompt.choose(
      `${isNew ? 'Initial setup' : 'Configuration'} — choose an area to configure:`,
      [
        'Server and storage',
        'Users and permissions',
        'File access rules',
        'Authentication settings',
        'Rotate JWT signing secret (invalidates all active tokens)',
        'Review and save',
        'Exit without saving'
      ]
    );

    if (selected === 1) {
      await configureServer(config, prompt);
      dirty = true;
    } else if (selected === 2) {
      await manageUsers(config, prompt);
      dirty = true;
    } else if (selected === 3) {
      await configureRules(config, prompt);
      dirty = true;
    } else if (selected === 4) {
      await configureAuthentication(config, prompt);
      dirty = true;
    } else if (selected === 5) {
      if (await prompt.confirm('Generate a new JWT secret? Existing login tokens will stop working.')) {
        config.auth.jwtSecret = crypto.randomBytes(48).toString('base64url');
        prompt.output.write('A new JWT secret has been generated; its value will not be displayed.\n');
        dirty = true;
      }
    } else if (selected === 6) {
      prompt.output.write(`${JSON.stringify(redactConfig(config), null, 2)}\n`);
      if (!dirty) {
        if (await prompt.confirm('No changes were made. Save the current configuration anyway?')) {
          return true;
        }
      } else if (await prompt.confirm('Validate and save this configuration?')) {
        return true;
      }
    } else {
      if (!dirty || await prompt.confirm('Discard unsaved configuration changes?')) {
        return false;
      }
    }
  }
}

function configPathFromArgs(args) {
  const index = args.indexOf('--config');
  if (index === -1) {
    return path.resolve(process.cwd(), 'config.json');
  }
  if (!args[index + 1]) {
    throw new Error('Usage: npm run setup -- [--config <path>]');
  }
  return path.resolve(args[index + 1]);
}

async function run(configPath, prompt = new ConsolePrompter()) {
  if (!prompt.input.isTTY) {
    throw new Error('Setup requires an interactive terminal.');
  }
  const { config, isNew } = readExistingConfig(configPath);
  config.auth.principals = Object.assign(Object.create(null), config.auth.principals || {});
  for (const user of config.auth.users || []) {
    const principalId = user.principal || user.username;
    if (!Object.hasOwn(config.auth.principals, principalId)) {
      const scopes = user.allowedSubdirs === undefined ? ['*'] : user.allowedSubdirs;
      config.auth.principals[principalId] = {
        grants: scopes.map(scope => ({
          path: scope === '*' ? '/*' : `/${scope.replace(/^\/+/, '').replace(/\/$/, '')}/*`,
          operations: [...OPERATIONS]
        }))
      };
    }
  }
  if (isNew) {
    await initialSetup(config, prompt);
  }
  const shouldSave = await mainMenu(config, prompt, isNew);
  if (!shouldSave) {
    prompt.output.write('No configuration was saved.\n');
    return false;
  }

  saveConfig(configPath, config);
  prompt.output.write(`Configuration saved to ${path.resolve(configPath)} (permissions 0600).\n`);
  prompt.output.write('Start the server with npm start.\n');
  return true;
}

if (require.main === module) {
  try {
    const configPath = configPathFromArgs(process.argv.slice(2));
    run(configPath).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  ConsolePrompter,
  configureRules,
  createDefaultConfig,
  createSetupTemplate,
  isValidGrantPath,
  mainMenu,
  parseCommaSeparated,
  readExistingConfig,
  redactConfig,
  run,
  saveConfig
};
