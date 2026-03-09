const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

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
app.get('/voice', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  accounts[username.toLowerCase()] = { username, password, role: 'user', settings: defaultSettings() };
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true, username: acc.username, role: acc.role || 'user', settings: acc.settings });
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

// ─── SERVERS (flat JSON file) ─────────────────────────────────────────────────
const SERVERS_FILE = path.join(__dirname, 'servers.json');

function loadServers() {
  try { return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')); }
  catch { return { servers: [] }; }
}

function saveServers(data) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(data, null, 2));
}

if (!fs.existsSync(SERVERS_FILE)) {
  saveServers({ servers: [{ id: 'default', name: 'Community Server', requireMembership: false, members: [], parties: 12 }] });
}

// ─── OWNER CODE (formerly admin password) ────────────────────────────────────
const OWNER_CODE = 'OathGuild@1995';

// ─── STATE ────────────────────────────────────────────────────────────────────
const users = {}; // socketId -> { username, party, serverId, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened }
const serverParties = {}; // serverId -> { 1: Set(), 2: Set(), ... }

function ensureServerParties(serverId) {
  if (serverParties[serverId]) return;
  const data = loadServers();
  const srv = data.servers.find(s => s.id === serverId);
  const count = srv ? srv.parties : 12;
  serverParties[serverId] = {};
  for (let i = 1; i <= count; i++) serverParties[serverId][i] = new Set();
}

function getServerPartyCount(serverId) {
  const data = loadServers();
  const srv = data.servers.find(s => s.id === serverId);
  return srv ? srv.parties : 12;
}

function serializeUser(sid) {
  const u = users[sid];
  return {
    socketId:         sid,
    username:         u?.username,
    isBroadcaster:    u?.isBroadcaster    || false,
    broadcastTargets: u?.broadcastTargets  || 'all',
    broadcastPaused:  u?.broadcastPaused   || false,
    isAdmin:          u?.isAdmin           || false,
    serverMuted:      u?.serverMuted       || false,
    selfMuted:        u?.selfMuted         || false,
    selfDeafened:     u?.selfDeafened       || false
  };
}

function getPartyList(serverId) {
  if (!serverId || !serverParties[serverId]) return {};
  const result = {};
  const parties = serverParties[serverId];
  for (const id of Object.keys(parties)) {
    result[id] = [...parties[id]].map(serializeUser);
  }
  return result;
}

function emitToServer(serverId, event, data) {
  io.to(`server-${serverId}`).emit(event, data);
}

function getServerMembers(serverId) {
  const data = loadServers();
  const srv = data.servers.find(s => s.id === serverId);
  if (!srv) return [];

  const accounts = loadAccounts();
  let memberUsernames;
  if (srv.requireMembership) {
    memberUsernames = srv.members;
  } else {
    memberUsernames = Object.values(accounts).map(a => a.username);
  }

  const onlineMap = {};
  for (const [sid, u] of Object.entries(users)) {
    if (u.serverId === serverId) {
      onlineMap[u.username.toLowerCase()] = { socketId: sid, party: u.party };
    }
  }

  return memberUsernames.map(name => {
    const online = onlineMap[name.toLowerCase()];
    return {
      username: name,
      online: !!online,
      party: online ? online.party : null
    };
  });
}

function emitServerMemberUpdate(serverId) {
  const members = getServerMembers(serverId);
  io.to(`server-${serverId}`).emit('server-members', { members });
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('init', {});

  socket.on('join', ({ username }) => {
    const accounts = loadAccounts();
    const acc = accounts[username?.toLowerCase()];
    const role = acc?.role || 'user';
    const autoAdmin = role === 'admin' || role === 'owner';
    users[socket.id] = { username, party: null, serverId: null, isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false, isAdmin: autoAdmin, serverMuted: false, selfMuted: false, selfDeafened: false, role };
    console.log(`${username} joined (role: ${role}${autoAdmin ? ', auto-admin' : ''})`);
    if (autoAdmin) socket.emit('role-admin-granted', { role });
  });

  // ── Server browsing & joining ──
  socket.on('get-servers', (cb) => {
    if (typeof cb !== 'function') return;
    const data = loadServers();
    const servers = data.servers.map(s => {
      let onlineCount = 0;
      for (const [sid, u] of Object.entries(users)) {
        if (u.serverId === s.id) onlineCount++;
      }
      return { ...s, onlineCount };
    });
    cb({ ok: true, servers });
  });

  socket.on('join-server', ({ serverId }, cb) => {
    if (typeof cb !== 'function') return;
    const user = users[socket.id];
    if (!user) return cb({ ok: false, error: 'Not authenticated' });

    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });

    if (srv.requireMembership && !srv.members.includes(user.username)) {
      return cb({ ok: false, error: 'This server requires membership.' });
    }

    // Leave current server's party if in one
    if (user.serverId && user.party !== null) {
      const oldParties = serverParties[user.serverId];
      if (oldParties && oldParties[user.party]) {
        oldParties[user.party].delete(socket.id);
        socket.leave(`server-${user.serverId}-party-${user.party}`);
        socket.to(`server-${user.serverId}-party-${user.party}`).emit('peer-left', { socketId: socket.id });
      }
      user.party = null;
      emitToServer(user.serverId, 'party-update', getPartyList(user.serverId));
    }

    // Leave old server room, join new one
    if (user.serverId) socket.leave(`server-${user.serverId}`);
    user.serverId = serverId;
    socket.join(`server-${serverId}`);
    ensureServerParties(serverId);

    const members = getServerMembers(serverId);

    cb({ ok: true, partyList: getPartyList(serverId), partyCount: getServerPartyCount(serverId), members });
    emitServerMemberUpdate(serverId);
  });

  socket.on('join-party', ({ partyId }) => {
    const user = users[socket.id];
    if (!user || !user.serverId) return;
    const serverId = user.serverId;
    ensureServerParties(serverId);
    const parties = serverParties[serverId];

    if (user.party !== null && parties[user.party]) {
      parties[user.party].delete(socket.id);
      socket.leave(`server-${serverId}-party-${user.party}`);
      socket.to(`server-${serverId}-party-${user.party}`).emit('peer-left', { socketId: socket.id });
    }
    user.party = partyId;
    if (!parties[partyId]) parties[partyId] = new Set();
    parties[partyId].add(socket.id);
    socket.join(`server-${serverId}-party-${partyId}`);
    const peersInParty = [...parties[partyId]]
      .filter(sid => sid !== socket.id)
      .map(serializeUser);
    socket.emit('party-peers', { peers: peersInParty, partyId });
    socket.to(`server-${serverId}-party-${partyId}`).emit('peer-joined', serializeUser(socket.id));
    emitToServer(serverId, 'party-update', getPartyList(serverId));
    emitServerMemberUpdate(serverId);
  });

  socket.on('leave-party', () => {
    const user = users[socket.id];
    if (!user || !user.serverId || user.party === null) return;
    const serverId = user.serverId;
    const parties = serverParties[serverId];
    if (parties && parties[user.party]) {
      parties[user.party].delete(socket.id);
      socket.leave(`server-${serverId}-party-${user.party}`);
      socket.to(`server-${serverId}-party-${user.party}`).emit('peer-left', { socketId: socket.id });
    }
    user.party = null;
    emitToServer(serverId, 'party-update', getPartyList(serverId));
    emitServerMemberUpdate(serverId);
  });

  socket.on('set-broadcaster', ({ isBroadcaster, targets, paused }) => {
    const user = users[socket.id];
    if (!user) return;
    user.isBroadcaster = isBroadcaster;
    if (targets !== undefined) user.broadcastTargets = targets;
    if (paused !== undefined) user.broadcastPaused = paused;
    if (user.serverId) {
      if (isBroadcaster) {
        emitToServer(user.serverId, 'broadcaster-joined', { socketId: socket.id, username: user.username, targets: user.broadcastTargets, paused: user.broadcastPaused });
      } else {
        emitToServer(user.serverId, 'broadcaster-left', { socketId: socket.id });
      }
      emitToServer(user.serverId, 'party-update', getPartyList(user.serverId));
    }
  });

  socket.on('set-broadcast-paused', ({ paused }) => {
    const user = users[socket.id];
    if (!user || !user.isBroadcaster) return;
    user.broadcastPaused = paused;
    if (user.serverId) {
      emitToServer(user.serverId, 'broadcaster-paused', { socketId: socket.id, paused });
      emitToServer(user.serverId, 'party-update', getPartyList(user.serverId));
    }
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
    const serversToUpdate = new Set();
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = true;
        u.role = 'admin';
        io.to(sid).emit('role-admin-granted', { role: 'admin' });
        if (u.serverId) serversToUpdate.add(u.serverId);
      }
    }
    serversToUpdate.forEach(sid => emitToServer(sid, 'party-update', getPartyList(sid)));
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
    const serversToUpdate = new Set();
    for (const [sid, u] of Object.entries(users)) {
      if (u.username?.toLowerCase() === key) {
        u.isAdmin = false;
        u.role = 'user';
        io.to(sid).emit('role-admin-revoked');
        if (u.serverId) serversToUpdate.add(u.serverId);
      }
    }
    serversToUpdate.forEach(sid => emitToServer(sid, 'party-update', getPartyList(sid)));
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
    if (admin.serverId) emitToServer(admin.serverId, 'party-update', getPartyList(admin.serverId));
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
    if (!admin?.isAdmin || !admin.serverId) return;
    const target = users[targetId];
    if (!target) return;
    const serverId = admin.serverId;
    ensureServerParties(serverId);
    const parties = serverParties[serverId];

    if (target.party !== null && parties[target.party]) {
      parties[target.party].delete(targetId);
      io.to(`server-${serverId}-party-${target.party}`).emit('peer-left', { socketId: targetId });
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) targetSocket.leave(`server-${serverId}-party-${target.party}`);
    }

    target.party = toPartyId;
    if (!parties[toPartyId]) parties[toPartyId] = new Set();
    parties[toPartyId].add(targetId);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.join(`server-${serverId}-party-${toPartyId}`);
      const peersInParty = [...parties[toPartyId]]
        .filter(sid => sid !== targetId)
        .map(serializeUser);
      targetSocket.emit('party-peers', { peers: peersInParty, partyId: toPartyId });
      targetSocket.to(`server-${serverId}-party-${toPartyId}`).emit('peer-joined', serializeUser(targetId));
      targetSocket.emit('admin-moved', { by: admin.username, toPartyId });
    }
    emitToServer(serverId, 'party-update', getPartyList(serverId));
    console.log(`[ADMIN] ${admin.username} moved ${target.username} to party ${toPartyId}`);
  });

  // ── User: update self-mute state ──
  socket.on('set-self-muted', ({ muted }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfMuted = muted;
    if (user.serverId) emitToServer(user.serverId, 'party-update', getPartyList(user.serverId));
  });

  // ── User: update self-deafen state ──
  socket.on('set-self-deafened', ({ deafened }) => {
    const user = users[socket.id];
    if (!user) return;
    user.selfDeafened = deafened;
    if (deafened) user.selfMuted = true;
    if (user.serverId) emitToServer(user.serverId, 'party-update', getPartyList(user.serverId));
  });

  // ── Latency: respond to ping-check so client can measure RTT ──
  socket.on('ping-check', (cb) => {
    if (typeof cb === 'function') cb();
  });

  // ── Latency: relay a user's reported latency to their party ──
  socket.on('latency-report', ({ latency }) => {
    const user = users[socket.id];
    if (!user || !user.serverId || user.party === null) return;
    socket.to(`server-${user.serverId}-party-${user.party}`).volatile.emit('latency-update', { socketId: socket.id, latency });
  });

  // ── Audio relay ──
  socket.on('audio-chunk', (chunk) => {
    const user = users[socket.id];
    if (!user || user.serverMuted || !user.serverId) return;
    const serverId = user.serverId;
    const parties = serverParties[serverId];
    if (!parties) return;
    const numParties = getServerPartyCount(serverId);

    if (user.isBroadcaster) {
      if (user.party === null) return;
      if (user.broadcastPaused) {
        socket.to(`server-${serverId}-party-${user.party}`).volatile.emit('audio-from', { from: socket.id, chunk });
        return;
      }
      const targets = user.broadcastTargets;
      if (targets === 'all') {
        for (let i = 1; i <= numParties; i++) {
          socket.to(`server-${serverId}-party-${i}`).volatile.emit('audio-from', { from: socket.id, chunk });
        }
      } else if (Array.isArray(targets)) {
        for (const partyId of targets) {
          socket.to(`server-${serverId}-party-${partyId}`).volatile.emit('audio-from', { from: socket.id, chunk });
        }
      }
      return;
    }

    if (user.party !== null) {
      socket.to(`server-${serverId}-party-${user.party}`).volatile.emit('audio-from', { from: socket.id, chunk });
    }
  });

  // ── Owner: create server ──
  socket.on('owner-create-server', ({ name, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    if (!name || !name.trim()) return cb({ ok: false, error: 'Server name required' });
    const data = loadServers();
    const id = 'server-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    data.servers.push({ id, name: name.trim(), requireMembership: false, members: [], parties: 12 });
    saveServers(data);
    cb({ ok: true, server: data.servers[data.servers.length - 1] });
  });

  // ── Owner: delete server ──
  socket.on('owner-delete-server', ({ serverId, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const data = loadServers();
    const idx = data.servers.findIndex(s => s.id === serverId);
    if (idx === -1) return cb({ ok: false, error: 'Server not found' });
    data.servers.splice(idx, 1);
    saveServers(data);
    for (const [sid, u] of Object.entries(users)) {
      if (u.serverId === serverId) {
        u.serverId = null;
        u.party = null;
        io.to(sid).emit('server-deleted', { serverId });
      }
    }
    delete serverParties[serverId];
    cb({ ok: true });
  });

  // ── Owner: rename server ──
  socket.on('owner-rename-server', ({ serverId, name, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    if (!name || !name.trim()) return cb({ ok: false, error: 'Name required' });
    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });
    srv.name = name.trim();
    saveServers(data);
    cb({ ok: true });
  });

  // ── Owner: toggle membership ──
  socket.on('owner-toggle-membership', ({ serverId, requireMembership, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });
    srv.requireMembership = !!requireMembership;
    saveServers(data);
    cb({ ok: true });
  });

  // ── Owner: add member ──
  socket.on('owner-add-member', ({ serverId, username, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });
    if (!srv.members.includes(username)) {
      srv.members.push(username);
      saveServers(data);
    }
    cb({ ok: true, members: srv.members });
  });

  // ── Owner: remove member ──
  socket.on('owner-remove-member', ({ serverId, username, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });
    srv.members = srv.members.filter(m => m !== username);
    saveServers(data);
    cb({ ok: true, members: srv.members });
  });

  // ── Owner: set party count ──
  socket.on('owner-set-parties', ({ serverId, count, ownerCode: code }, cb) => {
    if (typeof cb !== 'function') return;
    if (code !== OWNER_CODE) return cb({ ok: false, error: 'Unauthorized' });
    if (!count || count < 1 || count > 50) return cb({ ok: false, error: 'Party count must be 1-50' });
    const data = loadServers();
    const srv = data.servers.find(s => s.id === serverId);
    if (!srv) return cb({ ok: false, error: 'Server not found' });
    srv.parties = count;
    saveServers(data);
    if (serverParties[serverId]) {
      for (let i = 1; i <= count; i++) {
        if (!serverParties[serverId][i]) serverParties[serverId][i] = new Set();
      }
      for (const key of Object.keys(serverParties[serverId])) {
        if (parseInt(key, 10) > count) {
          const partySet = serverParties[serverId][key];
          for (const sid of partySet) {
            const u = users[sid];
            if (u) {
              u.party = null;
              const s = io.sockets.sockets.get(sid);
              if (s) {
                s.leave(`server-${serverId}-party-${key}`);
                s.emit('admin-moved', { by: 'System', toPartyId: null });
              }
            }
          }
          delete serverParties[serverId][key];
        }
      }
      emitToServer(serverId, 'party-update', getPartyList(serverId));
    }
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      const serverId = user.serverId;
      if (serverId && user.party !== null) {
        const parties = serverParties[serverId];
        if (parties && parties[user.party]) {
          parties[user.party].delete(socket.id);
          socket.to(`server-${serverId}-party-${user.party}`).emit('peer-left', { socketId: socket.id });
        }
      }
      if (user.isBroadcaster && serverId) {
        emitToServer(serverId, 'broadcaster-left', { socketId: socket.id });
      }
      delete users[socket.id];
      if (serverId) {
        emitToServer(serverId, 'party-update', getPartyList(serverId));
        emitServerMemberUpdate(serverId);
      }
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
