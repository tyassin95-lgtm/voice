const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  path: '/voice/socket.io',
  cors: { origin: '*' },
  maxHttpBufferSize: 5e6,
  pingTimeout:  60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  // Disable per-message compression for audio — saves CPU, audio is already dense
  perMessageDeflate: false
});

app.use(express.json());
app.use('/voice', express.static(path.join(__dirname, 'public')));
app.get('/voice', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
  accounts[username.toLowerCase()] = { username, password, settings: defaultSettings() };
  saveAccounts(accounts);
  res.json({ ok: true });
});

app.post('/voice/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const accounts = loadAccounts();
  const acc = accounts[username?.toLowerCase()];
  if (!acc || acc.password !== password) return res.json({ ok: false, error: 'Invalid credentials' });
  res.json({ ok: true, username: acc.username, settings: acc.settings });
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

// ─── ADMIN PASSWORD ───────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'OathGuild2026';

// ─── STATE ────────────────────────────────────────────────────────────────────
const users   = {}; // socketId -> { username, party, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened }
const parties = {};
const NUM_PARTIES = 12;
for (let i = 1; i <= NUM_PARTIES; i++) parties[i] = new Set();

function getPartyList() {
  const result = {};
  for (let i = 1; i <= NUM_PARTIES; i++) {
    result[i] = [...parties[i]].map(sid => ({
      socketId:         sid,
      username:         users[sid]?.username,
      isBroadcaster:    users[sid]?.isBroadcaster    || false,
      broadcastTargets: users[sid]?.broadcastTargets  || 'all',
      broadcastPaused:  users[sid]?.broadcastPaused   || false,
      isAdmin:          users[sid]?.isAdmin           || false,
      serverMuted:      users[sid]?.serverMuted       || false,
      selfMuted:        users[sid]?.selfMuted         || false,
      selfDeafened:     users[sid]?.selfDeafened       || false
    }));
  }
  return result;
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);
  socket.emit('init', { partyList: getPartyList() });

  socket.on('join', ({ username }) => {
    users[socket.id] = { username, party: null, isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false, isAdmin: false, serverMuted: false, selfMuted: false, selfDeafened: false };
    console.log(`${username} joined`);
    io.emit('party-update', getPartyList());
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
      .map(sid => ({ socketId: sid, username: users[sid]?.username, isBroadcaster: users[sid]?.isBroadcaster || false, broadcastTargets: users[sid]?.broadcastTargets || 'all', broadcastPaused: users[sid]?.broadcastPaused || false, isAdmin: users[sid]?.isAdmin || false, serverMuted: users[sid]?.serverMuted || false, selfMuted: users[sid]?.selfMuted || false, selfDeafened: users[sid]?.selfDeafened || false }));
    socket.emit('party-peers', { peers: peersInParty, partyId });
    socket.to(`party-${partyId}`).emit('peer-joined', { socketId: socket.id, username: user.username, isBroadcaster: user.isBroadcaster, broadcastTargets: user.broadcastTargets, broadcastPaused: user.broadcastPaused, isAdmin: user.isAdmin, serverMuted: user.serverMuted, selfMuted: user.selfMuted, selfDeafened: user.selfDeafened });
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

  // ── Admin: claim powers ──
  socket.on('claim-admin', ({ password }, cb) => {
    if (typeof cb !== 'function') return;
    if (password !== ADMIN_PASSWORD) return cb({ ok: false, error: 'Wrong password' });
    const user = users[socket.id];
    if (!user) return cb({ ok: false });
    user.isAdmin = true;
    io.emit('party-update', getPartyList());
    cb({ ok: true });
  });

  socket.on('revoke-admin', () => {
    const user = users[socket.id];
    if (user) { user.isAdmin = false; io.emit('party-update', getPartyList()); }
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

    // Remove from old party
    if (target.party !== null) {
      parties[target.party].delete(targetId);
      io.to(`party-${target.party}`).emit('peer-left', { socketId: targetId });
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) targetSocket.leave(`party-${target.party}`);
    }

    // Add to new party
    target.party = toPartyId;
    parties[toPartyId].add(targetId);
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.join(`party-${toPartyId}`);

      const peersInParty = [...parties[toPartyId]]
        .filter(sid => sid !== targetId)
        .map(sid => ({ socketId: sid, username: users[sid]?.username, isBroadcaster: users[sid]?.isBroadcaster || false, broadcastTargets: users[sid]?.broadcastTargets || 'all', broadcastPaused: users[sid]?.broadcastPaused || false, isAdmin: users[sid]?.isAdmin || false, serverMuted: users[sid]?.serverMuted || false, selfMuted: users[sid]?.selfMuted || false, selfDeafened: users[sid]?.selfDeafened || false }));
      targetSocket.emit('party-peers', { peers: peersInParty, partyId: toPartyId });

      targetSocket.to(`party-${toPartyId}`).emit('peer-joined', { socketId: targetId, username: target.username, isBroadcaster: target.isBroadcaster, broadcastTargets: target.broadcastTargets, broadcastPaused: target.broadcastPaused, isAdmin: target.isAdmin, serverMuted: target.serverMuted, selfMuted: target.selfMuted, selfDeafened: target.selfDeafened });

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

  // ── Audio relay ──
  // Use volatile for audio: drops packets under backpressure instead of queuing
  // (queued audio = ever-growing latency, dropped audio = momentary glitch)
  socket.on('audio-chunk', (chunk) => {
    const user = users[socket.id];
    if (!user || user.serverMuted) return;
    if (user.isBroadcaster) {
      if (user.broadcastPaused) return;
      const targets = user.broadcastTargets;
      if (targets === 'all') {
        // Broadcast to everyone except self
        socket.broadcast.volatile.emit('audio-from', { from: socket.id, chunk });
      } else if (Array.isArray(targets)) {
        // Broadcast to specific party rooms
        for (const partyId of targets) {
          socket.to(`party-${partyId}`).volatile.emit('audio-from', { from: socket.id, chunk });
        }
      }
    } else if (user.party !== null) {
      socket.to(`party-${user.party}`).volatile.emit('audio-from', { from: socket.id, chunk });
    }
  });

  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      if (user.party !== null) {
        parties[user.party].delete(socket.id);
        socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
      }
      if (user.isBroadcaster) io.emit('broadcaster-left', { socketId: socket.id });
      delete users[socket.id];
      io.emit('party-update', getPartyList());
    }
    console.log('Disconnected:', socket.id);
  });
});

// Express error handler — return JSON instead of HTML stack traces
app.use((err, req, res, next) => {
  console.error('[Express error]', err.message);
  res.status(err.status || 500).json({ ok: false, error: 'Server error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  OathlyVoice running at http://localhost:${PORT}\n`);
});
