const bcrypt = require('bcryptjs');

function generatePasswordHash(password) {
  const saltRounds = 10;
  const hash = bcrypt.hashSync(password, saltRounds);
  return hash;
}

// Get password from command line argument
const password = process.argv[2];

if (!password) {
  console.log('Usage: node scripts/generate-hash.js <password>');
  console.log('Example: node scripts/generate-hash.js mysecretpassword');
  process.exit(1);
}

const hash = generatePasswordHash(password);
console.log('Password hash:');
console.log(hash);
console.log('\nCopy this hash into your config.json under users[].passwordHash');
