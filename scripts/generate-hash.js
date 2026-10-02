#!/usr/bin/env node

const { ConsolePrompter } = require('./setup');

async function main() {
  if (!process.stdin.isTTY) {
    throw new Error('Password entry requires an interactive terminal.');
  }
  const prompt = new ConsolePrompter();
  const hash = await prompt.passwordPair('Password (input hidden, 12 characters minimum)');
  console.log(`Password hash:\n${hash}`);
  console.log('\nPrefer npm run setup to configure a user without copying hashes.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
