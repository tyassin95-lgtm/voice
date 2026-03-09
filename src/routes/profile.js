const express = require('express');
const path    = require('path');
const multer  = require('multer');
const { loadAccounts, saveAccounts } = require('../services/accountService');

const router = express.Router();

// ── Multer config for avatar uploads ──
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'public', 'uploads', 'avatars'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const safeName = _req.body.username
      ? _req.body.username.toLowerCase().replace(/[^a-z0-9_-]/g, '') + '-' + Date.now() + ext
      : 'avatar-' + Date.now() + ext;
    cb(null, safeName);
  }
});

const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

const upload = multer({
  storage,
  limits: { fileSize: MAX_AVATAR_BYTES },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpe?g|png|gif|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  }
});

// POST /voice/api/upload-avatar
router.post('/upload-avatar', upload.single('avatar'), (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });

  acc.avatarUrl = '/voice/uploads/avatars/' + req.file.filename;
  saveAccounts(accounts);
  res.json({ ok: true, avatarUrl: acc.avatarUrl });
});

// POST /voice/api/update-profile
router.post('/update-profile', (req, res) => {
  const { username, password, bio, bannerColor, customStatus } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });

  if (bio !== undefined)          acc.bio          = String(bio).slice(0, 190);
  if (bannerColor !== undefined)  acc.bannerColor  = String(bannerColor).slice(0, 7);
  if (customStatus !== undefined) acc.customStatus = String(customStatus).slice(0, 60);

  saveAccounts(accounts);
  res.json({ ok: true, bio: acc.bio, bannerColor: acc.bannerColor, customStatus: acc.customStatus });
});

module.exports = router;
