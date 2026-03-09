const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcrypt');
const crypto  = require('crypto');
const multer  = require('multer');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  perMessageDeflate: false
});

app.use(express.json());

// ─── DIRECTORIES ──────────────────────────────────────────────────────────────
const SERVER_ICONS_DIR   = path.join(__dirname, 'server_icons');
const PROFILE_IMAGES_DIR = path.join(__dirname, 'profile_images');
if (!fs.existsSync(SERVER_ICONS_DIR))   fs.mkdirSync(SERVER_ICONS_DIR);
if (!fs.existsSync(PROFILE_IMAGES_DIR)) fs.mkdirSync(PROFILE_IMAGES_DIR);

// Multer for file uploads (2 MB limit)
const upload = multer({ dest: '/tmp/voice_uploads', limits: { fileSize: 2 * 1024 * 1024 } });

app.use('/voice', express.static(path.join(__dirname, 'public')));
app.use('/voice/server_icons',   express.static(SERVER_ICONS_DIR));
app.use('/voice/profile_images', express.static(PROFILE_IMAGES_DIR));
app.get('/voice', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── OWNER CODE ───────────────────────────────────────────────────────────────
const OWNER_CODE = 'OathGuild@1995';

// ─── ACCOUNTS (flat JSON file) ────────────────────────────────────────────────
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

app.post('/voice/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });
  const accounts = loadAccounts();
  if (accounts[username.toLowerCase()]) return res.json({ ok: false, error: 'Username taken' });
  accounts[username.toLowerCase()] = {
    username, password,
    role: 'user',
    bio: '',
    avatar: '',
    createdAt: Date.now(),
    settings: defaultSettings()
  };
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Invalid credentials' });
  res.json({
    ok: true,
    username: acc.username,
    role: acc.role || 'user',
    settings: acc.settings,
    bio: acc.bio || '',
    avatar: acc.avatar || ''
  });
});

app.post('/voice/api/save-settings', (req, res) => {
  const { username, password, settings } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  acc.settings = { ...acc.settings, ...settings };
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/update-bio', (req, res) => {
  const { username, password, bio } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  acc.bio = (bio || '').substring(0, 200);
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/upload-avatar', upload.single('avatar'), (req, res) => {
  const username = req.body?.username;
  const password = req.body?.password;
  if (!username || !password) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Unauthorized' });
  }
  const accounts = loadAccounts();
  const acc = accounts[username.toLowerCase()];
  if (!acc || acc.password !== password) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Unauthorized' });
  }
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Invalid file type' });
  }
  // Delete old avatar
  if (acc.avatar) {
    const oldPath = path.join(__dirname, acc.avatar);
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch {}
  }
  const avatarFilename = username.toLowerCase() + '.png';
  const avatarPath = path.join(PROFILE_IMAGES_DIR, avatarFilename);
  try { fs.renameSync(req.file.path, avatarPath); } catch {
    try { fs.copyFileSync(req.file.path, avatarPath); fs.unlinkSync(req.file.path); } catch {}
  }
  acc.avatar = 'profile_images/' + avatarFilename;
  saveAccounts(accounts);
  res.json({ ok: true, avatar: acc.avatar });
});

function defaultSettings() {
  return {
    micSensitivity: 50,
    pushToTalk: false,
    pttKey: 'Space',
    pttTouch: false,
    muteKeybind: false,
    muteKey: 'KeyM',
    bcPauseKeybind: false,
    bcPauseKey: 'KeyB',
    inputVolume: 100
  };
}

// ─── SERVERS (flat JSON file) ─────────────────────────────────────────────────
const SERVERS_FILE = path.join(__dirname, 'servers.json');

function loadServers() {
  try { return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); }
  catch { return { servers: {} }; }
}

function saveServers(data) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2));
}

if (!fs.existsSync(SERVERS_FILE)) {
  saveServers({ servers: {} });
}

// Server REST APIs
app.get('/voice/api/servers', (_req, res) => {
  const data = loadServers();
  const list = Object.values(data.servers).map(s => ({
    id: s.id, name: s.name, description: s.description || '',
    icon: s.icon || '', membershipRequired: s.membershipRequired || false,
    owner: s.owner, memberCount: (s.members || []).length,
    channelCount: Object.keys(s.channels || {}).length
  }));
  res.json({ ok: true, servers: list });
});

app.post('/voice/api/server-detail', (req, res) => {
  const { serverId, username } = req.body || {};
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return res.json({ ok: false, error: 'Server not found' });
  const channels = {};
  Object.entries(sv.channels || {}).forEach(([chId, ch]) => {
    channels[chId] = { ...ch, password: undefined, hasPassword: !!ch.password };
  });
  const isMember = (sv.members || []).includes(username);
  const isAdmin  = sv.owner === username || (sv.admins || []).includes(username);
  const isPending = (sv.pendingApplications || []).includes(username);
  res.json({ ok: true, server: {
    id: sv.id, name: sv.name, description: sv.description || '',
    icon: sv.icon || '', membershipRequired: sv.membershipRequired || false,
    owner: sv.owner, admins: sv.admins || [], members: sv.members || [],
    pendingApplications: isAdmin ? (sv.pendingApplications || []) : [],
    channels, isMember, isAdmin, isPending
  }});
});

app.post('/voice/api/create-server', (req, res) => {
  const { ownerCode, name, description, membershipRequired, username } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  if (!name) return res.json({ ok: false, error: 'Server name required' });
  const data = loadServers();
  const id = crypto.randomBytes(8).toString('hex');
  data.servers[id] = {
    id, name, description: description || '', icon: '',
    membershipRequired: membershipRequired || false,
    owner: username || '', admins: [],
    members: [username].filter(Boolean),
    pendingApplications: [],
    channels: {
      general: { id: 'general', name: 'General', type: 'voice', private: false, password: null, temporary: false, createdBy: username || 'system' }
    },
    createdAt: Date.now()
  };
  saveServers(data);
  res.json({ ok: true, server: { ...data.servers[id], channels: undefined } });
});

app.post('/voice/api/delete-server', (req, res) => {
  const { ownerCode, serverId } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const data = loadServers();
  if (!data.servers[serverId]) return res.json({ ok: false, error: 'Server not found' });
  const iconPath = path.join(SERVER_ICONS_DIR, serverId + '.png');
  try { if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath); } catch {}
  delete data.servers[serverId];
  saveServers(data);
  Object.entries(users).forEach(([sid, u]) => {
    if (u.serverId === serverId) {
      u.serverId = null; u.channelId = null;
      io.to(sid).emit('server-deleted', { serverId });
    }
  });
  res.json({ ok: true });
});

app.post('/voice/api/upload-server-icon', upload.single('icon'), (req, res) => {
  const ownerCode = req.body?.ownerCode;
  const serverId  = req.body?.serverId;
  if (ownerCode !== OWNER_CODE) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Unauthorized' });
  }
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(req.file.mimetype)) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Invalid file type' });
  }
  const data = loadServers();
  if (!data.servers[serverId]) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.json({ ok: false, error: 'Server not found' });
  }
  const iconFilename = serverId + '.png';
  const iconPath = path.join(SERVER_ICONS_DIR, iconFilename);
  try { if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath); } catch {}
  try { fs.renameSync(req.file.path, iconPath); } catch {
    try { fs.copyFileSync(req.file.path, iconPath); fs.unlinkSync(req.file.path); } catch {}
  }
  data.servers[serverId].icon = 'server_icons/' + iconFilename;
  saveServers(data);
  res.json({ ok: true, icon: data.servers[serverId].icon });
});

app.post('/voice/api/apply-server', (req, res) => {
  const { serverId, username } = req.body || {};
  if (!serverId || !username) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return res.json({ ok: false, error: 'Server not found' });
  if (!sv.membershipRequired) {
    if (!sv.members.includes(username)) { sv.members.push(username); saveServers(data); }
    return res.json({ ok: true, joined: true });
  }
  if (sv.members.includes(username)) return res.json({ ok: true, joined: true });
  if (sv.pendingApplications.includes(username)) return res.json({ ok: false, error: 'Already pending' });
  sv.pendingApplications.push(username);
  saveServers(data);
  res.json({ ok: true, pending: true });
});

app.post('/voice/api/approve-member', (req, res) => {
  const { serverId, targetUsername, username } = req.body || {};
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return res.json({ ok: false, error: 'Server not found' });
  if (!isUserServerAdmin(username, serverId)) return res.json({ ok: false, error: 'Unauthorized' });
  const idx = (sv.pendingApplications || []).indexOf(targetUsername);
  if (idx === -1) return res.json({ ok: false, error: 'No pending application' });
  sv.pendingApplications.splice(idx, 1);
  if (!sv.members.includes(targetUsername)) sv.members.push(targetUsername);
  saveServers(data);
  res.json({ ok: true });
});

app.post('/voice/api/reject-member', (req, res) => {
  const { serverId, targetUsername, username } = req.body || {};
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return res.json({ ok: false, error: 'Server not found' });
  if (!isUserServerAdmin(username, serverId)) return res.json({ ok: false, error: 'Unauthorized' });
  const idx = (sv.pendingApplications || []).indexOf(targetUsername);
  if (idx === -1) return res.json({ ok: false, error: 'No pending application' });
  sv.pendingApplications.splice(idx, 1);
  saveServers(data);
  res.json({ ok: true });
});

function isUserServerAdmin(username, serverId) {
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return false;
  if (sv.owner === username) return true;
  if ((sv.admins || []).includes(username)) return true;
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  return acc && (acc.role === 'admin' || acc.role === 'owner');
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const users = {}; // socketId -> { username, serverId, channelId, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened, ... }

function serializeUser(sid) {
  const u = users[sid];
  return {
    socketId:         sid,
    username:         u?.username,
    serverId:         u?.serverId     || null,
    channelId:        u?.channelId    || null,
    isBroadcaster:    u?.isBroadcaster    || false,
    broadcastTargets: u?.broadcastTargets  || 'all',
    broadcastPaused:  u?.broadcastPaused   || false,
    isAdmin:          u?.isAdmin           || false,
    serverMuted:      u?.serverMuted       || false,
    selfMuted:        u?.selfMuted         || false,
    selfDeafened:     u?.selfDeafened       || false
  };
}

function roomName(serverId, channelId) {
  return `${serverId}:${channelId}`;
}

function getServerChannelList(serverId) {
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return {};
  const result = {};
  Object.keys(sv.channels).forEach(chId => {
    result[chId] = Object.entries(users)
      .filter(([, u]) => u.serverId === serverId && u.channelId === chId)
      .map(([sid]) => serializeUser(sid));
  });
  return result;
}

function getServerOnlineMembers(serverId) {
  return Object.entries(users)
    .filter(([, u]) => u.serverId === serverId)
    .map(([sid]) => serializeUser(sid));
}

function emitServerUpdate(serverId) {
  io.emit('server-channel-update', { serverId, channelList: getServerChannelList(serverId) });
  io.emit('server-members-update', { serverId, onlineMembers: getServerOnlineMembers(serverId) });
}

function checkTemporaryChannel(serverId, channelId) {
  const data = loadServers();
  const sv = data.servers[serverId];
  if (!sv) return;
  const ch = sv.channels[channelId];
  if (!ch || !ch.temporary) return;
  const count = Object.values(users).filter(u => u.serverId === serverId && u.channelId === channelId).length;
  if (count === 0) {
    delete sv.channels[channelId];
    saveServers(data);
    emitServerUpdate(serverId);
  }
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('join', ({ username }) => {
    const accounts = loadAccounts();
    const acc = accounts[username?.toLowerCase()];
    const role = acc?.role || 'user';
    const autoAdmin = role === 'admin' || role === 'owner';
    users[socket.id] = {
      username, serverId: null, channelId: null,
      isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false,
      isAdmin: autoAdmin, serverMuted: false, selfMuted: false, selfDeafened: false, role
    };
    console.log(`${username} joined (role: ${role}${autoAdmin ? ', auto-admin' : ''})`);
    if (autoAdmin) socket.emit('role-admin-granted', { role });
  });

  // ── Server: join ──
  socket.on('join-server', ({ serverId }) => {
    const user = users[socket.id];
    if (!user) return;
    if (user.serverId && user.channelId) {
      const oldRoom = roomName(user.serverId, user.channelId);
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('peer-left', { socketId: socket.id });
      checkTemporaryChannel(user.serverId, user.channelId);
    }
    const oldServerId = user.serverId;
    user.serverId  = serverId;
    user.channelId = null;
    user.isAdmin   = isUserServerAdmin(user.username, serverId);
    socket.emit('server-joined', {
      serverId, channelList: getServerChannelList(serverId), isAdmin: user.isAdmin
    });
    emitServerUpdate(serverId);
    if (oldServerId && oldServerId !== serverId) emitServerUpdate(oldServerId);
  });

  // ── Channel: join ──
  socket.on('join-channel', ({ serverId, channelId, password }) => {
    const user = users[socket.id];
    if (!user) return;
    const data = loadServers();
    const sv = data.servers[serverId];
    if (!sv) return;
    const ch = sv.channels[channelId];
    if (!ch) return;
    // Private channel check
    if (ch.private && ch.password) {
      if (!password) { socket.emit('channel-password-required', { serverId, channelId }); return; }
      if (!bcrypt.compareSync(password, ch.password)) { socket.emit('channel-password-wrong', { serverId, channelId }); return; }
    }
    // Leave current channel
    if (user.channelId !== null && user.serverId) {
      const oldRoom = roomName(user.serverId, user.channelId);
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('peer-left', { socketId: socket.id });
      checkTemporaryChannel(user.serverId, user.channelId);
    }
    user.serverId  = serverId;
    user.channelId = channelId;
    user.isAdmin   = isUserServerAdmin(user.username, serverId);
    const room = roomName(serverId, channelId);
    socket.join(room);
    const peers = Object.entries(users)
      .filter(([sid, u]) => u.serverId === serverId && u.channelId === channelId && sid !== socket.id)
      .map(([sid]) => serializeUser(sid));
    socket.emit('channel-peers', { peers, serverId, channelId });
    socket.to(room).emit('peer-joined', serializeUser(socket.id));
    emitServerUpdate(serverId);
  });

  // ── Channel: leave ──
  socket.on('leave-channel', () => {
    const user = users[socket.id];
    if (!user || user.channelId === null) return;
    const sid = user.serverId, chid = user.channelId;
    socket.leave(roomName(sid, chid));
    socket.to(roomName(sid, chid)).emit('peer-left', { socketId: socket.id });
    user.channelId = null;
    checkTemporaryChannel(sid, chid);
    emitServerUpdate(sid);
  });

  // ── Channel: create ──
  socket.on('create-channel', ({ serverId, name, type, isPrivate, password, temporary }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const user = users[socket.id];
    if (!user) return cb({ ok: false });
    const data = loadServers();
    const sv = data.servers[serverId];
    if (!sv) return cb({ ok: false, error: 'Server not found' });
    const isServerAdmin = isUserServerAdmin(user.username, serverId);
    if (!isServerAdmin && !temporary) return cb({ ok: false, error: 'Only admins can create permanent channels' });
    const channelId = crypto.randomBytes(6).toString('hex');
    let hashedPw = null;
    if (isPrivate && password) hashedPw = bcrypt.hashSync(password, 10);
    sv.channels[channelId] = {
      id: channelId, name: name || 'New Channel', type: type || 'voice',
      private: isPrivate || false, password: hashedPw,
      temporary: temporary || false, createdBy: user.username
    };
    saveServers(data);
    emitServerUpdate(serverId);
    cb({ ok: true, channelId });
  });

  // ── Channel: delete (admin only) ──
  socket.on('delete-channel', ({ serverId, channelId }, cb) => {
    if (typeof cb !== 'function') cb = () => {};
    const user = users[socket.id];
    if (!user || !isUserServerAdmin(user.username, serverId)) return cb({ ok: false, error: 'Unauthorized' });
    const data = loadServers();
    const sv = data.servers[serverId];
    if (!sv || !sv.channels[channelId]) return cb({ ok: false, error: 'Not found' });
    Object.entries(users).forEach(([sid, u]) => {
      if (u.serverId === serverId && u.channelId === channelId) {
        u.channelId = null;
        const s = io.sockets.sockets.get(sid);
        if (s) { s.leave(roomName(serverId, channelId)); s.emit('channel-deleted', { serverId, channelId }); }
      }
    });
    delete sv.channels[channelId];
    saveServers(data);
    emitServerUpdate(serverId);
    cb({ ok: true });
  });

  // ── Broadcast (preserved logic, updated room names) ──
  socket.on('set-broadcaster', ({ isBroadcaster, targets, paused }) => {
    const user = users[socket.id];
    if (!user) return;
    user.isBroadcaster = isBroadcaster;
    if (targets !== undefined) user.broadcastTargets = targets;
    if (paused !== undefined) user.broadcastPaused  = paused;
    if (isBroadcaster) {
      io.emit('broadcaster-joined', { socketId: socket.id, username: user.username, targets: user.broadcastTargets, paused: user.broadcastPaused });
    } else {
      io.emit('broadcaster-left', { socketId: socket.id });
    }
    if (user.serverId) emitServerUpdate(user.serverId);
  });

  socket.on('set-broadcast-paused', ({ paused }) => {
    const user = users[socket.id];
    if (!user || !user.isBroadcaster) return;
    user.broadcastPaused = paused;
    io.emit('broadcaster-paused', { socketId: socket.id, paused });
    if (user.serverId) emitServerUpdate(user.serverId);
  });

  // ── Owner: verify owner code ──
  socket.on('claim-admin', ({ password }, cb) => {
    if (typeof cb !== 'function') return;
    if (password !== OWNER_CODE) return cb({ ok: false, error: 'Wrong password' });
    const user = users[socket.id];
    if (!user) return cb({ ok: false });
    cb({ ok: true, isOwner: true });
  });

  // Deprecated: kept for backwards compatibility
  socket.on('revoke-admin', () => {});
  socket.on('claim-role-admin', () => {});

  // ── Owner: search registered users ──
  socket.on('owner-search-users', ({ query, ownerCode }, cb) => {
    if (typeof cb !== 'function') return;
    if (ownerCode !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const accounts = loadAccounts();
    const q = (query || '').toLowerCase().trim();
    const results = Object.values(accounts)
      .filter(acc => !q || acc.username.toLowerCase().includes(q))
      .map(acc => ({ username: acc.username, role: acc.role || 'user' }))
      .slice(0, 50);
    cb({ ok: true, users: results });
  });

  // ── Owner: grant admin role ──
  socket.on('owner-grant-admin', ({ targetUsername, ownerCode }, cb) => {
    if (typeof cb !== 'function') return;
    if (ownerCode !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const accounts = loadAccounts();
    const key = targetUsername?.toLowerCase();
    const acc = accounts[key];
    if (!acc) return cb({ ok: false, error: 'User not found' });
    if (acc.role === 'owner') return cb({ ok: false, error: 'Cannot modify owner role' });
    acc.role = 'admin';
    saveAccounts(accounts);
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = true; u.role = 'admin';
        io.to(sid).emit('role-admin-granted', { role: 'admin' });
      }
    }
    cb({ ok: true });
  });

  // ── Owner: revoke admin role ──
  socket.on('owner-revoke-admin', ({ targetUsername, ownerCode }, cb) => {
    if (typeof cb !== 'function') return;
    if (ownerCode !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const accounts = loadAccounts();
    const key = targetUsername?.toLowerCase();
    const acc = accounts[key];
    if (!acc) return cb({ ok: false, error: 'User not found' });
    if (acc.role === 'owner') return cb({ ok: false, error: 'Cannot modify owner role' });
    acc.role = 'user';
    saveAccounts(accounts);
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = false; u.role = 'user';
        io.to(sid).emit('role-admin-revoked');
      }
    }
    cb({ ok: true });
  });

  // ── Admin: server-mute a user ──
  socket.on('admin-mute', ({ targetId, muted }) => {
    const admin = users[socket.id];
    if (!admin?.isAdmin) return;
    const target = users[targetId];
    if (!target) return;
    target.serverMuted = muted;
    io.to(targetId).emit('server-muted', { muted, by: admin.username });
    if (admin.serverId) emitServerUpdate(admin.serverId);
    console.log(`[ADMIN] ${admin.username} ${muted ? 'muted' : 'unmuted'} ${target.username}`);
  });

  // ── Admin: disconnect a user ──
  socket.on('admin-disconnect', ({ targetId }) => {
    const admin = users[socket.id];
    if (!admin?.isAdmin) return;
    const target = users[targetId];
    if (!target) return;
    console.log(`[ADMIN] ${admin.username} disconnected ${target.username}`);
    io.to(targetId).emit('force-disconnect', { by: admin.username });
    setTimeout(() => {
      const s = io.sockets.sockets.get(targetId);
      if (s) s.disconnect(true);
    }, 500);
  });

  // ── Admin: move user to different channel ──
  socket.on('admin-move', ({ targetId, toChannelId }) => {
    const admin = users[socket.id];
    if (!admin?.isAdmin) return;
    const target = users[targetId];
    if (!target) return;
    const serverId = target.serverId || admin.serverId;
    if (target.serverId && target.channelId) {
      const oldRoom = roomName(target.serverId, target.channelId);
      io.to(oldRoom).emit('peer-left', { socketId: targetId });
      const ts = io.sockets.sockets.get(targetId);
      if (ts) ts.leave(oldRoom);
    }
    target.serverId  = serverId;
    target.channelId = toChannelId;
    const newRoom = roomName(serverId, toChannelId);
    const ts = io.sockets.sockets.get(targetId);
    if (ts) {
      ts.join(newRoom);
      const peers = Object.entries(users)
        .filter(([s, u]) => u.serverId === serverId && u.channelId === toChannelId && s !== targetId)
        .map(([s]) => serializeUser(s));
      ts.emit('channel-peers', { peers, serverId, channelId: toChannelId });
      ts.to(newRoom).emit('peer-joined', serializeUser(targetId));
      ts.emit('admin-moved', { by: admin.username, toChannelId });
    }
    if (serverId) emitServerUpdate(serverId);
    console.log(`[ADMIN] ${admin.username} moved ${target.username} to channel ${toChannelId}`);
  });

  // ── User: update self-mute state ──
  socket.on('set-self-muted', ({ muted }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfMuted = muted;
    if (user.serverId) emitServerUpdate(user.serverId);
  });

  // ── User: update self-deafen state ──
  socket.on('set-self-deafened', ({ deafened }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfDeafened = deafened;
    if (deafened) user.selfMuted = true;
    if (user.serverId) emitServerUpdate(user.serverId);
  });

  // ── Latency ──
  socket.on('ping-check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  socket.on('latency-report', ({ latency }) => {
    const user = users[socket.id];
    if (!user || !user.serverId || !user.channelId) return;
    socket.to(roomName(user.serverId, user.channelId)).volatile.emit('latency-update', { socketId: socket.id, latency });
  });

  // ── Audio relay (preserved logic, updated room names) ──
  socket.on('audio-chunk', (chunk) => {
    const user = users[socket.id];
    if (!user || user.serverMuted) return;

    // Broadcaster logic
    if (user.isBroadcaster) {
      if (!user.serverId || !user.channelId) return;
      // Paused → talk only to own channel
      if (user.broadcastPaused) {
        socket.to(roomName(user.serverId, user.channelId)).volatile.emit('audio-from', { from: socket.id, chunk });
        return;
      }
      const targets = user.broadcastTargets;
      const data = loadServers();
      const sv = data.servers[user.serverId];
      if (targets === 'all' && sv) {
        Object.keys(sv.channels).forEach(chId => {
          socket.to(roomName(user.serverId, chId)).volatile.emit('audio-from', { from: socket.id, chunk });
        });
      } else if (Array.isArray(targets)) {
        for (const chId of targets) {
          socket.to(roomName(user.serverId, chId)).volatile.emit('audio-from', { from: socket.id, chunk });
        }
      }
      return;
    }

    // Normal user audio
    if (user.serverId && user.channelId) {
      socket.to(roomName(user.serverId, user.channelId)).volatile.emit('audio-from', { from: socket.id, chunk });
    }
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      if (user.serverId && user.channelId) {
        socket.to(roomName(user.serverId, user.channelId)).emit('peer-left', { socketId: socket.id });
        checkTemporaryChannel(user.serverId, user.channelId);
      }
      if (user.isBroadcaster) io.emit('broadcaster-left', { socketId: socket.id });
      const sid = user.serverId;
      delete users[socket.id];
      if (sid) emitServerUpdate(sid);
    }
    console.log('Disconnected:', socket.id);
  });
});

// Express error handler
app.use((err, _req, res, _next) => {
  console.error('[Express error]', err.message);
  res.status(err.status || 500).json({ ok: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  OathlyVoice running at http://localhost:${PORT}\n`);
});
