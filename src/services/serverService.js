const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'servers.json');

function loadServers() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function saveServers(d) {
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

module.exports = { loadServers, saveServers };
