const express = require('express');
const { loadAccounts, saveAccounts } = require('../services/accountService');
const { defaultSettings } = require('../config');

const router = express.Router();

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });
  const accounts = loadAccounts();
  if (accounts[username.toLowerCase()]) return res.json({ ok: false, error: 'Username taken' });
  accounts[username.toLowerCase()] = { username, password, role: 'user', settings: defaultSettings() };
  saveAccounts(accounts);
  res.json({ ok: true });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true, username: acc.username, role: acc.role || 'user', settings: acc.settings });
});

router.post('/save-settings', (req, res) => {
  const { username, password, settings } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  acc.settings = { ...acc.settings, ...settings };
  saveAccounts(accounts);
  res.json({ ok: true });
});

module.exports = router;
