const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const multer  = require('multer');
const { loadAccounts, saveAccounts } = require('../services/accountService');
const { loadServers, saveServers }   = require('../services/serverService');
const { defaultSettings, OWNER_CODE } = require('../config');

const router = express.Router();

// ── Multer config for banner uploads ──
const bannerStorage = multer.diskStorage({
  destination: path.join(__dirname, '..', '..', 'public', 'uploads', 'banners'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const serverId = _req.body.serverId || 'srv';
    cb(null, serverId + ext);
  }
});
const bannerUpload = multer({
  storage: bannerStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(jpe?g|png|gif|webp)$/i;
    if (allowed.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  }
});

// Invite code generation: XXXX-XXXX, uppercase alphanumeric, no 0/O/I/1
const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += INVITE_CHARS[crypto.randomInt(INVITE_CHARS.length)];
  }
  return code;
}

// Auth helper: verify username + password, return account or null
function authUser(body) {
  const { username, password } = body || {};
  if (!username || !password) return null;
  const accounts = loadAccounts();
  const acc = accounts[username.toLowerCase()];
  if (!acc || acc.password !== password) return null;
  return acc;
}

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
  res.json({ ok: true, username: acc.username, role: acc.role || 'user', settings: acc.settings, avatarUrl: acc.avatarUrl || '', bannerColor: acc.bannerColor || '#5865f2', bio: acc.bio || '', customStatus: acc.customStatus || '' });
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

// ═══ SERVER MANAGEMENT ROUTES ═══

// GET /voice/api/servers/list?username&password&ownerCode
router.get('/servers/list', (req, res) => {
  const acc = authUser(req.query);
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const isOwner = acc.role === 'owner' || req.query.ownerCode === OWNER_CODE;
  const servers = loadServers();

  const myServers = [];
  const discoverableServers = [];
  const pendingServers = [];

  for (const srv of Object.values(servers)) {
    const isMember = srv.members.includes(uname) || srv.admins.includes(uname) || isOwner;
    const isPending = (srv.pendingRequests || []).includes(uname);
    const isAdmin = isOwner || srv.admins.includes(uname);

    if (isMember) {
      const copy = { ...srv };
      // Strip invite code values for non-admins
      if (!isAdmin) {
        delete copy.inviteCodes;
        copy.pendingRequests = [];
      }
      myServers.push(copy);
    } else if (isPending) {
      pendingServers.push({ id: srv.id, name: srv.name, bannerUrl: srv.bannerUrl || '' });
    } else if (srv.discoverable) {
      discoverableServers.push({ id: srv.id, name: srv.name, bannerUrl: srv.bannerUrl || '', memberCount: (srv.members || []).length + (srv.admins || []).length });
    }
  }
  res.json({ ok: true, myServers, discoverableServers, pendingServers });
});

// POST /voice/api/servers/create
router.post('/servers/create', (req, res) => {
  const { ownerCode, name, channelCount, discoverable } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const trimName = (name || '').trim();
  if (trimName.length < 2 || trimName.length > 40) return res.json({ ok: false, error: 'Name must be 2-40 characters' });
  const chCount = Math.min(20, Math.max(1, parseInt(channelCount) || 4));

  const now = Date.now();
  const rnd = crypto.randomInt(1000, 9999);
  const id = 'srv_' + now + '_' + rnd;
  const channels = [];
  for (let i = 0; i < chCount; i++) {
    channels.push({ id: 'ch_' + now + '_' + i, name: 'Channel ' + (i + 1) });
  }

  const server = {
    id, name: trimName, bannerUrl: '', channelCount: chCount, discoverable: !!discoverable,
    createdAt: now, channels, members: [], admins: [], pendingRequests: [], inviteCodes: {}
  };

  const servers = loadServers();
  servers[id] = server;
  saveServers(servers);
  res.json({ ok: true, server });
});

// POST /voice/api/servers/upload-banner
router.post('/servers/upload-banner', bannerUpload.single('banner'), (req, res) => {
  const { ownerCode, serverId } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });
  srv.bannerUrl = '/voice/uploads/banners/' + req.file.filename;
  saveServers(servers);
  res.json({ ok: true, bannerUrl: srv.bannerUrl });
});

// POST /voice/api/servers/edit
router.post('/servers/edit', (req, res) => {
  const { ownerCode, serverId, name, channelCount, discoverable } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });

  if (name !== undefined) {
    const trimName = String(name).trim();
    if (trimName.length >= 2 && trimName.length <= 40) srv.name = trimName;
  }
  if (discoverable !== undefined) srv.discoverable = !!discoverable;
  if (channelCount !== undefined) {
    const newCount = Math.min(20, Math.max(1, parseInt(channelCount) || srv.channelCount));
    if (newCount > srv.channels.length) {
      const now = Date.now();
      for (let i = srv.channels.length; i < newCount; i++) {
        srv.channels.push({ id: 'ch_' + now + '_' + i, name: 'Channel ' + (i + 1) });
      }
    } else if (newCount < srv.channels.length) {
      srv.channels = srv.channels.slice(0, newCount);
    }
    srv.channelCount = newCount;
  }

  saveServers(servers);
  res.json({ ok: true, server: srv });
});

// POST /voice/api/servers/delete
router.post('/servers/delete', (req, res) => {
  const { ownerCode, serverId } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  if (!servers[serverId]) return res.json({ ok: false, error: 'Server not found' });
  delete servers[serverId];
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/create-invite
router.post('/servers/create-invite', (req, res) => {
  const { username, password, serverId, expiryHours } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const uname = acc.username.toLowerCase();
  const isOwner = acc.role === 'owner';
  if (!isOwner && !srv.admins.includes(uname)) return res.json({ ok: false, error: 'Only admins can create invites' });

  const hours = [1, 24, 168, 720].includes(expiryHours) ? expiryHours : 24;
  const now = Date.now();
  const code = generateInviteCode();
  if (!srv.inviteCodes) srv.inviteCodes = {};
  srv.inviteCodes[code] = { createdAt: now, expiresAt: now + hours * 3600000, createdBy: uname };
  saveServers(servers);
  res.json({ ok: true, code, expiresAt: srv.inviteCodes[code].expiresAt });
});

// POST /voice/api/servers/join-by-invite
router.post('/servers/join-by-invite', (req, res) => {
  const { username, password, code } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const servers = loadServers();

  // Find server by invite code
  let foundServer = null;
  for (const srv of Object.values(servers)) {
    if (srv.inviteCodes && srv.inviteCodes[code]) {
      foundServer = srv;
      break;
    }
  }
  if (!foundServer) return res.json({ ok: false, error: 'Invalid invite code' });
  const invite = foundServer.inviteCodes[code];
  if (Date.now() > invite.expiresAt) return res.json({ ok: false, error: 'Invite code has expired' });
  if (foundServer.members.includes(uname) || foundServer.admins.includes(uname)) return res.json({ ok: false, error: 'Already a member' });

  // Remove from pending if present
  foundServer.pendingRequests = (foundServer.pendingRequests || []).filter(u => u !== uname);
  foundServer.members.push(uname);
  saveServers(servers);
  res.json({ ok: true, serverId: foundServer.id });
});

// POST /voice/api/servers/request-access
router.post('/servers/request-access', (req, res) => {
  const { username, password, serverId } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  if (srv.members.includes(uname) || srv.admins.includes(uname)) return res.json({ ok: false, error: 'Already a member' });
  if ((srv.pendingRequests || []).includes(uname)) return res.json({ ok: false, error: 'Request already pending' });

  if (!srv.pendingRequests) srv.pendingRequests = [];
  srv.pendingRequests.push(uname);
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/approve-request
router.post('/servers/approve-request', (req, res) => {
  const { username, password, serverId, targetUsername } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const isOwner = acc.role === 'owner';
  if (!isOwner && !srv.admins.includes(uname)) return res.json({ ok: false, error: 'Only admins can approve' });

  const tname = targetUsername?.toLowerCase();
  if (!(srv.pendingRequests || []).includes(tname)) return res.json({ ok: false, error: 'No pending request' });
  srv.pendingRequests = srv.pendingRequests.filter(u => u !== tname);
  if (!srv.members.includes(tname)) srv.members.push(tname);
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/deny-request
router.post('/servers/deny-request', (req, res) => {
  const { username, password, serverId, targetUsername } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const isOwner = acc.role === 'owner';
  if (!isOwner && !srv.admins.includes(uname)) return res.json({ ok: false, error: 'Only admins can deny' });

  const tname = targetUsername?.toLowerCase();
  srv.pendingRequests = (srv.pendingRequests || []).filter(u => u !== tname);
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/remove-member
router.post('/servers/remove-member', (req, res) => {
  const { username, password, serverId, targetUsername } = req.body || {};
  const acc = authUser({ username, password });
  if (!acc) return res.json({ ok: false, error: 'Unauthorized' });
  const uname = acc.username.toLowerCase();
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const isOwner = acc.role === 'owner';
  if (!isOwner && !srv.admins.includes(uname)) return res.json({ ok: false, error: 'Only admins can remove' });

  const tname = targetUsername?.toLowerCase();
  // Admins cannot remove other admins — only owner can
  if (!isOwner && srv.admins.includes(tname)) return res.json({ ok: false, error: 'Only the owner can remove admins' });

  srv.members = (srv.members || []).filter(u => u !== tname);
  srv.admins = (srv.admins || []).filter(u => u !== tname);
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/promote-admin
router.post('/servers/promote-admin', (req, res) => {
  const { ownerCode, serverId, targetUsername } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const tname = targetUsername?.toLowerCase();
  if (!srv.members.includes(tname) && !srv.admins.includes(tname)) return res.json({ ok: false, error: 'Not a member' });
  if (!srv.admins.includes(tname)) srv.admins.push(tname);
  saveServers(servers);
  res.json({ ok: true });
});

// POST /voice/api/servers/demote-admin
router.post('/servers/demote-admin', (req, res) => {
  const { ownerCode, serverId, targetUsername } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const servers = loadServers();
  const srv = servers[serverId];
  if (!srv) return res.json({ ok: false, error: 'Server not found' });
  const tname = targetUsername?.toLowerCase();
  srv.admins = (srv.admins || []).filter(u => u !== tname);
  saveServers(servers);
  res.json({ ok: true });
});

module.exports = router;
