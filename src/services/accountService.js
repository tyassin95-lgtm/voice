const fs = require('fs');
const { ACCOUNTS_FILE } = require('../config');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

module.exports = { loadAccounts, saveAccounts };
