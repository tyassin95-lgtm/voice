const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const bcrypt  = require('bcrypt');
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
app.use('/voice', express.static(path.join(__dirname, 'public')));
app.use('/voice/server_icons', express.static(path.join(__dirname, 'server_icons')));
app.use('/voice/profile_images', express.static(path.join(__dirname, 'profile_images')));
app.get('/voice', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Ensure upload directories exist
['server_icons', 'profile_images'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// ─── ACCOUNTS (flat JSON file) ────────────────────────────────────────────────
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAccounts(data) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

// REST endpoints for account management
app.post('/voice/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });
  const accounts = loadAccounts();
  if (accounts[username.toLowerCase()]) return res.json({ ok: false, error: 'Username taken' });
  accounts[username.toLowerCase()] = { username, password, role: 'user', bio: '', avatar: null, createdAt: Date.now(), settings: defaultSettings() };
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true, username: acc.username, role: acc.role || 'user', settings: acc.settings, bio: acc.bio || '', avatar: acc.avatar || null });
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

// ─── SERVERS (flat JSON file) ────────────────────────────────────────────────
const SERVERS_FILE = path.join(__dirname, 'servers.json');

function loadServers() {
  try { return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); }
  catch { return { servers: {} }; }
}

function saveServers(data) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2));
}

// Ensure servers.json exists
if (!fs.existsSync(SERVERS_FILE)) saveServers({ servers: {} });

// ─── MULTER SETUP ────────────────────────────────────────────────────────────
const serverIconStorage = multer.diskStorage({
  destination: path.join(__dirname, 'server_icons'),
  filename: (_req, file, cb) => {
    const serverId = _req.body.serverId;
    if (!serverId) return cb(new Error('Missing serverId'));
    cb(null, serverId + path.extname(file.originalname));
  }
});
const serverIconUpload = multer({
  storage: serverIconStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

const avatarStorage = multer.diskStorage({
  destination: path.join(__dirname, 'profile_images'),
  filename: (req, file, cb) => {
    const username = req.body.username;
    if (!username) return cb(new Error('Missing username'));
    cb(null, username.toLowerCase() + path.extname(file.originalname));
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ─── SERVER MANAGEMENT ROUTES (Owner only) ───────────────────────────────────

app.post('/voice/api/create-server', (req, res) => {
  const { ownerCode, name, description, membershipRequired, ownerUsername } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  if (!name || !ownerUsername) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const id = 'srv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  data.servers[id] = {
    id,
    name,
    description: description || '',
    icon: 'server_icons/' + id + '.png',
    membershipRequired: !!membershipRequired,
    owner: ownerUsername,
    admins: [ownerUsername],
    members: [ownerUsername],
    pendingApplications: [],
    channels: {},
    createdAt: Date.now()
  };
  saveServers(data);
  res.json({ ok: true, server: data.servers[id] });
});

app.post('/voice/api/delete-server', (req, res) => {
  const { ownerCode, serverId } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  const data = loadServers();
  if (!data.servers[serverId]) return res.json({ ok: false, error: 'Server not found' });
  // Remove icon file
  const iconPath = path.join(__dirname, 'server_icons', serverId + '.png');
  try { if (fs.existsSync(iconPath)) fs.unlinkSync(iconPath); } catch(e) {}
  delete data.servers[serverId];
  saveServers(data);
  res.json({ ok: true });
});

app.post('/voice/api/upload-server-icon', serverIconUpload.single('icon'), (req, res) => {
  const { ownerCode, serverId } = req.body || {};
  if (ownerCode !== OWNER_CODE) return res.json({ ok: false, error: 'Unauthorized' });
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });
  const data = loadServers();
  if (!data.servers[serverId]) return res.json({ ok: false, error: 'Server not found' });
  // Rename to serverId.png
  const ext = path.extname(req.file.originalname) || '.png';
  const finalName = serverId + ext;
  const finalPath = path.join(__dirname, 'server_icons', finalName);
  if (req.file.path !== finalPath) {
    try { fs.renameSync(req.file.path, finalPath); } catch(e) {}
  }
  data.servers[serverId].icon = 'server_icons/' + finalName;
  saveServers(data);
  res.json({ ok: true, icon: data.servers[serverId].icon });
});

// ─── SERVER LIST ROUTE ───────────────────────────────────────────────────────
app.get('/voice/api/servers', (req, res) => {
  const data = loadServers();
  const serverList = Object.values(data.servers).map(s => ({
    id: s.id,
    name: s.name,
    description: s.description,
    icon: s.icon,
    membershipRequired: s.membershipRequired,
    owner: s.owner,
    memberCount: s.members.length,
    channelCount: Object.keys(s.channels).length
  }));
  res.json({ ok: true, servers: serverList });
});

app.get('/voice/api/server/:serverId', (req, res) => {
  const data = loadServers();
  const server = data.servers[req.params.serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  res.json({ ok: true, server });
});

// ─── MEMBERSHIP ROUTES ──────────────────────────────────────────────────────

app.post('/voice/api/apply-server', (req, res) => {
  const { serverId, username } = req.body || {};
  if (!serverId || !username) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  if (server.members.includes(username)) return res.json({ ok: false, error: 'Already a member' });
  if (server.pendingApplications.includes(username)) return res.json({ ok: false, error: 'Application already pending' });
  if (!server.membershipRequired) {
    server.members.push(username);
    saveServers(data);
    return res.json({ ok: true, joined: true });
  }
  server.pendingApplications.push(username);
  saveServers(data);
  res.json({ ok: true, applied: true });
});

app.post('/voice/api/approve-member', (req, res) => {
  const { serverId, username, adminUsername } = req.body || {};
  if (!serverId || !username || !adminUsername) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  if (!server.admins.includes(adminUsername) && server.owner !== adminUsername) return res.json({ ok: false, error: 'Unauthorized' });
  const idx = server.pendingApplications.indexOf(username);
  if (idx === -1) return res.json({ ok: false, error: 'No pending application' });
  server.pendingApplications.splice(idx, 1);
  if (!server.members.includes(username)) server.members.push(username);
  saveServers(data);
  res.json({ ok: true });
});

app.post('/voice/api/reject-member', (req, res) => {
  const { serverId, username, adminUsername } = req.body || {};
  if (!serverId || !username || !adminUsername) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  if (!server.admins.includes(adminUsername) && server.owner !== adminUsername) return res.json({ ok: false, error: 'Unauthorized' });
  const idx = server.pendingApplications.indexOf(username);
  if (idx === -1) return res.json({ ok: false, error: 'No pending application' });
  server.pendingApplications.splice(idx, 1);
  saveServers(data);
  res.json({ ok: true });
});

// ─── CHANNEL ROUTES ─────────────────────────────────────────────────────────

app.post('/voice/api/create-channel', async (req, res) => {
  const { serverId, name, type, isPrivate, password, temporary, username } = req.body || {};
  if (!serverId || !name || !username) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  if (!server.members.includes(username)) return res.json({ ok: false, error: 'Not a member' });
  const isServerAdmin = server.admins.includes(username) || server.owner === username;
  // Members can only create temporary channels
  if (!temporary && !isServerAdmin) return res.json({ ok: false, error: 'Only admins can create permanent channels' });
  const channelId = 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  let hashedPassword = null;
  if (isPrivate && password) {
    hashedPassword = await bcrypt.hash(password, 10);
  }
  server.channels[channelId] = {
    id: channelId,
    name,
    type: type || 'voice',
    private: !!isPrivate,
    password: hashedPassword,
    temporary: !!temporary,
    createdBy: username
  };
  saveServers(data);
  const { password: _pw, ...channelData } = server.channels[channelId];
  res.json({ ok: true, channel: channelData });
});

app.post('/voice/api/delete-channel', (req, res) => {
  const { serverId, channelId, username } = req.body || {};
  if (!serverId || !channelId || !username) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  if (!server.admins.includes(username) && server.owner !== username) return res.json({ ok: false, error: 'Unauthorized' });
  if (!server.channels[channelId]) return res.json({ ok: false, error: 'Channel not found' });
  delete server.channels[channelId];
  saveServers(data);
  res.json({ ok: true });
});

app.post('/voice/api/verify-channel-password', async (req, res) => {
  const { serverId, channelId, password } = req.body || {};
  if (!serverId || !channelId || !password) return res.json({ ok: false, error: 'Missing fields' });
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return res.json({ ok: false, error: 'Server not found' });
  const channel = server.channels[channelId];
  if (!channel) return res.json({ ok: false, error: 'Channel not found' });
  if (!channel.private || !channel.password) return res.json({ ok: true });
  const match = await bcrypt.compare(password, channel.password);
  if (!match) return res.json({ ok: false, error: 'Incorrect password' });
  res.json({ ok: true });
});

// ─── AVATAR UPLOAD ROUTE ────────────────────────────────────────────────────
app.post('/voice/api/upload-avatar', avatarUpload.single('avatar'), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });
  const accounts = loadAccounts();
  const acc = accounts[username.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  if (!req.file) return res.json({ ok: false, error: 'No file uploaded' });
  // Delete previous avatar if different name
  if (acc.avatar) {
    const oldPath = path.join(__dirname, acc.avatar);
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e) {}
  }
  const ext = path.extname(req.file.originalname) || '.png';
  const finalName = username.toLowerCase() + ext;
  const finalPath = path.join(__dirname, 'profile_images', finalName);
  if (req.file.path !== finalPath) {
    try { fs.renameSync(req.file.path, finalPath); } catch(e) {}
  }
  acc.avatar = 'profile_images/' + finalName;
  saveAccounts(accounts);
  res.json({ ok: true, avatar: acc.avatar });
});

// ─── USER PROFILE ROUTE ────────────────────────────────────────────────────
app.post('/voice/api/update-profile', (req, res) => {
  const { username, password, bio } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Missing fields' });
  const accounts = loadAccounts();
  const acc = accounts[username.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Unauthorized' });
  if (bio !== undefined) acc.bio = bio;
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.get('/voice/api/profile/:username', (req, res) => {
  const accounts = loadAccounts();
  const acc = accounts[req.params.username.toLowerCase()];
  if (!acc) return res.json({ ok: false, error: 'User not found' });
  res.json({
    ok: true,
    profile: {
      username: acc.username,
      bio: acc.bio || '',
      avatar: acc.avatar || null,
      createdAt: acc.createdAt || null
    }
  });
});

// ─── OWNER CODE (formerly admin password) ────────────────────────────────────
const OWNER_CODE = 'OathGuild@1995';

// ─── STATE ────────────────────────────────────────────────────────────────────
const users   = {}; // socketId -> { username, serverId, channelId, party, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened }
const parties = {};
const NUM_PARTIES = 12;
for (let i = 1; i <= NUM_PARTIES; i++) parties[i] = new Set();

// Channel rooms: 'serverId:channelId' -> Set<socketId>
const channelRooms = {};

function getChannelRoom(serverId, channelId) {
  return `${serverId}:${channelId}`;
}

function getChannelUserCount(serverId, channelId) {
  const room = getChannelRoom(serverId, channelId);
  return channelRooms[room] ? channelRooms[room].size : 0;
}

function cleanupTemporaryChannel(serverId, channelId) {
  const count = getChannelUserCount(serverId, channelId);
  if (count > 0) return;
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server || !server.channels[channelId]) return;
  if (server.channels[channelId].temporary) {
    delete server.channels[channelId];
    saveServers(data);
    // Notify connected clients about channel removal
    io.emit('channel-deleted', { serverId, channelId });
  }
}

function serializeUser(sid) {
  const u = users[sid];
  return {
    socketId:         sid,
    username:         u?.username,
    serverId:         u?.serverId         || null,
    channelId:        u?.channelId        || null,
    isBroadcaster:    u?.isBroadcaster    || false,
    broadcastTargets: u?.broadcastTargets  || 'all',
    broadcastPaused:  u?.broadcastPaused   || false,
    isAdmin:          u?.isAdmin           || false,
    serverMuted:      u?.serverMuted       || false,
    selfMuted:        u?.selfMuted         || false,
    selfDeafened:     u?.selfDeafened       || false
  };
}

function getPartyList() {
  const result = {};
  for (let i = 1; i <= NUM_PARTIES; i++) {
    result[i] = [...parties[i]].map(serializeUser);
  }
  return result;
}

function emitServerUpdate(serverId) {
  if (!serverId) return;
  // Build channel user data for this server
  const data = loadServers();
  const server = data.servers[serverId];
  if (!server) return;
  const channelUsers = {};
  for (const [chId, ch] of Object.entries(server.channels)) {
    const room = getChannelRoom(serverId, chId);
    channelUsers[chId] = channelRooms[room] ? [...channelRooms[room]].map(serializeUser) : [];
  }
  // Get online members
  const onlineMembers = new Set();
  for (const [sid, u] of Object.entries(users)) {
    if (server.members.includes(u.username)) onlineMembers.add(u.username);
  }
  io.emit('server-update', {
    serverId,
    channels: server.channels,
    channelUsers,
    onlineMembers: [...onlineMembers]
  });
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('init', { partyList: getPartyList() });

  socket.on('join', ({ username }) => {
    // Look up persistent role from accounts
    const accounts = loadAccounts();
    const acc = accounts[username?.toLowerCase()];
    const role = acc?.role || 'user';
    const autoAdmin = role === 'admin' || role === 'owner';
    users[socket.id] = { username, party: null, serverId: null, channelId: null, isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false, isAdmin: autoAdmin, serverMuted: false, selfMuted: false, selfDeafened: false, role };
    console.log(`${username} joined (role: ${role}${autoAdmin ? ', auto-admin' : ''})`);
    io.emit('party-update', getPartyList());
    // Notify the client of their role-based admin status
    if (autoAdmin) socket.emit('role-admin-granted', { role });
  });

  socket.on('join-party', ({ partyId }) => {
    const user = users[socket.id];
    if (!user) return;
    if (user.party !== null) {
      parties[user.party].delete(socket.id);
      socket.leave(`party-${user.party}`);
      socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
    }
    user.party = partyId;
    parties[partyId].add(socket.id);
    socket.join(`party-${partyId}`);
    const peersInParty = [...parties[partyId]]
      .filter(sid => sid !== socket.id)
      .map(serializeUser);
    socket.emit('party-peers', { peers: peersInParty, partyId });
    socket.to(`party-${partyId}`).emit('peer-joined', serializeUser(socket.id));
    io.emit('party-update', getPartyList());
  });

  socket.on('leave-party', () => {
    const user = users[socket.id];
    if (!user || user.party === null) return;
    parties[user.party].delete(socket.id);
    socket.leave(`party-${user.party}`);
    socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
    user.party = null;
    io.emit('party-update', getPartyList());
  });

  // ── Server channel join/leave ──
  socket.on('join-channel', ({ serverId, channelId }) => {
    const user = users[socket.id];
    if (!user) return;
    // Leave current channel if in one
    if (user.serverId && user.channelId) {
      const oldRoom = getChannelRoom(user.serverId, user.channelId);
      if (channelRooms[oldRoom]) channelRooms[oldRoom].delete(socket.id);
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('peer-left', { socketId: socket.id });
      const oldServerId = user.serverId;
      const oldChannelId = user.channelId;
      // Cleanup temp channel after leaving
      setTimeout(() => cleanupTemporaryChannel(oldServerId, oldChannelId), 500);
    }
    // Also leave any legacy party
    if (user.party !== null) {
      parties[user.party].delete(socket.id);
      socket.leave(`party-${user.party}`);
      socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
      user.party = null;
    }
    user.serverId = serverId;
    user.channelId = channelId;
    const room = getChannelRoom(serverId, channelId);
    if (!channelRooms[room]) channelRooms[room] = new Set();
    channelRooms[room].add(socket.id);
    socket.join(room);
    const peersInChannel = [...channelRooms[room]]
      .filter(sid => sid !== socket.id)
      .map(serializeUser);
    socket.emit('channel-peers', { peers: peersInChannel, serverId, channelId });
    socket.to(room).emit('peer-joined', serializeUser(socket.id));
    // Also emit server-specific user list update
    emitServerUpdate(serverId);
    io.emit('party-update', getPartyList());
  });

  socket.on('leave-channel', () => {
    const user = users[socket.id];
    if (!user || !user.serverId || !user.channelId) return;
    const room = getChannelRoom(user.serverId, user.channelId);
    if (channelRooms[room]) channelRooms[room].delete(socket.id);
    socket.leave(room);
    socket.to(room).emit('peer-left', { socketId: socket.id });
    const oldServerId = user.serverId;
    const oldChannelId = user.channelId;
    user.channelId = null;
    // Cleanup temp channel
    setTimeout(() => cleanupTemporaryChannel(oldServerId, oldChannelId), 500);
    emitServerUpdate(oldServerId);
    io.emit('party-update', getPartyList());
  });

  socket.on('select-server', ({ serverId }) => {
    const user = users[socket.id];
    if (!user) return;
    // Leave current channel if switching servers
    if (user.serverId && user.channelId) {
      const oldRoom = getChannelRoom(user.serverId, user.channelId);
      if (channelRooms[oldRoom]) channelRooms[oldRoom].delete(socket.id);
      socket.leave(oldRoom);
      socket.to(oldRoom).emit('peer-left', { socketId: socket.id });
      const oldServerId = user.serverId;
      const oldChannelId = user.channelId;
      user.channelId = null;
      setTimeout(() => cleanupTemporaryChannel(oldServerId, oldChannelId), 500);
    }
    user.serverId = serverId;
    emitServerUpdate(serverId);
  });

  // Request member list for a server (including online status)
  socket.on('get-server-members', ({ serverId }, cb) => {
    if (typeof cb !== 'function') return;
    const data = loadServers();
    const server = data.servers[serverId];
    if (!server) return cb({ ok: false, error: 'Server not found' });
    const onlineUsers = new Set();
    for (const [sid, u] of Object.entries(users)) {
      if (u.serverId === serverId) onlineUsers.add(u.username);
    }
    // Also check all connected users (they might be on the server even without selecting it)
    for (const [sid, u] of Object.entries(users)) {
      if (server.members.includes(u.username)) onlineUsers.add(u.username);
    }
    const members = server.members.map(m => ({
      username: m,
      online: onlineUsers.has(m)
    }));
    cb({ ok: true, members, pendingApplications: server.pendingApplications });
  });

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
    io.emit('party-update', getPartyList());
  });

  socket.on('set-broadcast-paused', ({ paused }) => {
    const user = users[socket.id];
    if (!user || !user.isBroadcaster) return;
    user.broadcastPaused = paused;
    io.emit('broadcaster-paused', { socketId: socket.id, paused });
    io.emit('party-update', getPartyList());
  });

  // ── Owner: verify owner code (opens management panel on client) ──
  socket.on('claim-admin', ({ password }, cb) => {
    if (typeof cb !== 'function') return;
    if (password !== OWNER_CODE) return cb({ ok: false, error: 'Wrong password' });
    const user = users[socket.id];
    if (!user) return cb({ ok: false });
    cb({ ok: true, isOwner: true });
  });

  // ── Deprecated: kept for backwards compatibility but no longer toggles admin ──
  socket.on('revoke-admin', () => {
    // No-op: admin privileges are now managed only through the owner panel
  });

  // ── Deprecated: kept for backwards compatibility but no longer toggles admin ──
  socket.on('claim-role-admin', () => {
    // No-op: admin privileges are now determined by stored role on join
  });

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
    // Update any currently connected session for this user
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = true;
        u.role = 'admin';
        io.to(sid).emit('role-admin-granted', { role: 'admin' });
      }
    }
    io.emit('party-update', getPartyList());
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
    // Update any currently connected session for this user
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = false;
        u.role = 'user';
        io.to(sid).emit('role-admin-revoked');
      }
    }
    io.emit('party-update', getPartyList());
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
    io.emit('party-update', getPartyList());
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

  // ── Admin: move user to different party ──
  socket.on('admin-move', ({ targetId, toPartyId }) => {
    const admin = users[socket.id];
    if (!admin?.isAdmin) return;
    const target = users[targetId];
    if (!target) return;

    if (target.party !== null) {
      parties[target.party].delete(targetId);
      io.to(`party-${target.party}`).emit('peer-left', { socketId: targetId });
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) targetSocket.leave(`party-${target.party}`);
    }

    target.party = toPartyId;
    parties[toPartyId].add(targetId);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.join(`party-${toPartyId}`);

      const peersInParty = [...parties[toPartyId]]
        .filter(sid => sid !== targetId)
        .map(serializeUser);
      targetSocket.emit('party-peers', { peers: peersInParty, partyId: toPartyId });
      targetSocket.to(`party-${toPartyId}`).emit('peer-joined', serializeUser(targetId));
      targetSocket.emit('admin-moved', { by: admin.username, toPartyId });
    }

    io.emit('party-update', getPartyList());
    console.log(`[ADMIN] ${admin.username} moved ${target.username} to party ${toPartyId}`);
  });

  // ── User: update self-mute state ──
  socket.on('set-self-muted', ({ muted }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfMuted = muted;
    io.emit('party-update', getPartyList());
  });

  // ── User: update self-deafen state ──
  socket.on('set-self-deafened', ({ deafened }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfDeafened = deafened;
    if (deafened) user.selfMuted = true;
    io.emit('party-update', getPartyList());
  });

  // ── Latency: respond to ping-check so client can measure RTT ──
  socket.on('ping-check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  // ── Latency: relay a user's reported latency to their party/channel ──
  socket.on('latency-report', ({ latency }) => {
    const user = users[socket.id];
    if (!user) return;
    if (user.serverId && user.channelId) {
      const room = getChannelRoom(user.serverId, user.channelId);
      socket.to(room).volatile.emit('latency-update', { socketId: socket.id, latency });
    } else if (user.party !== null) {
      socket.to(`party-${user.party}`).volatile.emit('latency-update', { socketId: socket.id, latency });
    }
  });

  // ── Audio relay ──
  // Use volatile for audio: drops packets under backpressure instead of queuing
  // (queued audio = ever-growing latency, dropped audio = momentary glitch)
socket.on('audio-chunk', (chunk) => {
  const user = users[socket.id];
  if (!user || user.serverMuted) return;

  // Broadcaster logic
  if (user.isBroadcaster) {

    // Rule 1: must be in a party or channel
    if (user.party === null && !user.channelId) return;

    // Rule 3: paused = talk only to own party/channel
    if (user.broadcastPaused) {
      if (user.channelId && user.serverId) {
        socket.to(getChannelRoom(user.serverId, user.channelId)).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
      } else if (user.party !== null) {
        socket.to(`party-${user.party}`).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
      }
      return;
    }

    // Rule 2: broadcast only to parties
    const targets = user.broadcastTargets;

    if (targets === 'all') {
      for (let i = 1; i <= NUM_PARTIES; i++) {
        socket.to(`party-${i}`).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
      }
      // Also broadcast to all channels in all servers
      for (const room of Object.keys(channelRooms)) {
        socket.to(room).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
      }
    } else if (Array.isArray(targets)) {
      for (const partyId of targets) {
        socket.to(`party-${partyId}`).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
      }
    }

    return;
  }

  // Normal user audio - send to channel room if in one
  if (user.channelId && user.serverId) {
    socket.to(getChannelRoom(user.serverId, user.channelId)).volatile.emit('audio-from', {
      from: socket.id,
      chunk
    });
    return;
  }

  // Legacy party audio
  if (user.party !== null) {
    socket.to(`party-${user.party}`).volatile.emit('audio-from', {
      from: socket.id,
      chunk
    });
  }
});

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      if (user.party !== null) {
        parties[user.party].delete(socket.id);
        socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
      }
      if (user.serverId && user.channelId) {
        const room = getChannelRoom(user.serverId, user.channelId);
        if (channelRooms[room]) channelRooms[room].delete(socket.id);
        socket.to(room).emit('peer-left', { socketId: socket.id });
        const oldServerId = user.serverId;
        const oldChannelId = user.channelId;
        setTimeout(() => cleanupTemporaryChannel(oldServerId, oldChannelId), 500);
        emitServerUpdate(oldServerId);
      }
      if (user.isBroadcaster) io.emit('broadcaster-left', { socketId: socket.id });
      delete users[socket.id];
      io.emit('party-update', getPartyList());
    }
    console.log('Disconnected:', socket.id);
  });
});

// Express error handler — return JSON instead of HTML stack traces
app.use((err, _req, res, _next) => {
  console.error('[Express error]', err.message);
  res.status(err.status || 500).json({ ok: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  OathlyVoice running at http://localhost:${PORT}\n`);
});
