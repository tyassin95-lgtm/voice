const { OWNER_CODE, NUM_PARTIES } = require('../config');
const { users, parties, serializeUser, getPartyList } = require('../state');
const { loadAccounts, saveAccounts } = require('../services/accountService');

function registerSocketHandlers(io) {

  // Helper: build a member list of ALL registered users with online status
  function getMemberList() {
    const accounts = loadAccounts();
    const onlineUsernames = new Set();
    for (const u of Object.values(users)) {
      if (u.username) onlineUsernames.add(u.username.toLowerCase());
    }
    return Object.values(accounts).map(acc => ({
      username:     acc.username,
      role:         acc.role || 'user',
      avatarUrl:    acc.avatarUrl || '',
      bannerColor:  acc.bannerColor || '#5865f2',
      bio:          acc.bio || '',
      customStatus: acc.customStatus || '',
      online:       onlineUsernames.has(acc.username.toLowerCase())
    }));
  }

  io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    socket.emit('init', { partyList: getPartyList(), memberList: getMemberList() });

    socket.on('join', ({ username }) => {
      // Look up persistent role from accounts
      const accounts = loadAccounts();
      const acc = accounts[username?.toLowerCase()];
      const role = acc?.role || 'user';
      const autoAdmin = role === 'admin' || role === 'owner';
      users[socket.id] = { username, party: null, isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false, isAdmin: autoAdmin, serverMuted: false, selfMuted: false, selfDeafened: false, role, avatarUrl: acc?.avatarUrl || '', bannerColor: acc?.bannerColor || '#5865f2', bio: acc?.bio || '' };
      console.log(`${username} joined (role: ${role}${autoAdmin ? ', auto-admin' : ''})`);
      io.emit('party-update', getPartyList());
      io.emit('member-list', getMemberList());
      // Notify the client of their role-based admin status
      if (autoAdmin) socket.emit('role-admin-granted', { role });
    });

    // ── User: update profile in real-time ──
    socket.on('update-profile', ({ avatarUrl, bannerColor, bio }) => {
      const user = users[socket.id];
      if (!user) return;
      if (avatarUrl !== undefined && typeof avatarUrl === 'string')
        user.avatarUrl = avatarUrl.slice(0, 300);
      if (bannerColor !== undefined && typeof bannerColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(bannerColor))
        user.bannerColor = bannerColor;
      if (bio !== undefined && typeof bio === 'string')
        user.bio = bio.slice(0, 190);
      io.emit('party-update', getPartyList());
      io.emit('member-list', getMemberList());
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
      if (user.isStreaming) {
        user.isStreaming = false;
        socket.to(`party-${user.party}`).emit('stream-ended', { streamerId: socket.id });
      }
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

    // ── Latency: relay a user's reported latency to their party ──
    socket.on('latency-report', ({ latency }) => {
      const user = users[socket.id];
      if (!user || user.party === null) return;
      socket.to(`party-${user.party}`).volatile.emit('latency-update', { socketId: socket.id, latency });
    });

    // ── Audio relay ──
    // Use volatile for audio: drops packets under backpressure instead of queuing
    // (queued audio = ever-growing latency, dropped audio = momentary glitch)
  socket.on('audio-chunk', (chunk) => {
    const user = users[socket.id];
    if (!user || user.serverMuted) return;

    // Broadcaster logic
    if (user.isBroadcaster) {

      // Rule 1: must be in a party
      if (user.party === null) return;

      // Rule 3: paused = talk only to own party
      if (user.broadcastPaused) {
        socket.to(`party-${user.party}`).volatile.emit('audio-from', {
          from: socket.id,
          chunk
        });
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

    // Normal user audio
    if (user.party !== null) {
      socket.to(`party-${user.party}`).volatile.emit('audio-from', {
        from: socket.id,
        chunk
      });
    }
  });

    // ── Screen share signaling ──
    socket.on('stream-start', () => {
      const user = users[socket.id];
      if (!user) return;
      user.isStreaming = true;
      io.emit('party-update', getPartyList());
      socket.to(`party-${user.party}`).emit('stream-available', { streamerId: socket.id, streamerName: user.username });
    });

    socket.on('stream-stop', () => {
      const user = users[socket.id];
      if (!user) return;
      user.isStreaming = false;
      io.emit('party-update', getPartyList());
      if (user.party !== null) socket.to(`party-${user.party}`).emit('stream-ended', { streamerId: socket.id });
    });

    socket.on('stream-watch-request', ({ streamerId }) => {
      const user = users[socket.id];
      if (!user) return;
      socket.to(streamerId).emit('stream-watch-request', { watcherId: socket.id, watcherName: user.username });
    });

    socket.on('stream-offer', ({ watcherId, offer }) => {
      const user = users[socket.id];
      if (!user) return;
      socket.to(watcherId).emit('stream-offer', { streamerId: socket.id, offer });
    });

    socket.on('stream-answer', ({ streamerId, answer }) => {
      const user = users[socket.id];
      if (!user) return;
      socket.to(streamerId).emit('stream-answer', { watcherId: socket.id, answer });
    });

    socket.on('stream-ice', ({ targetId, candidate }) => {
      const user = users[socket.id];
      if (!user) return;
      socket.to(targetId).emit('stream-ice', { fromId: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      const user = users[socket.id];
      if (user) {
        if (user.isStreaming && user.party !== null) {
          user.isStreaming = false;
          socket.to(`party-${user.party}`).emit('stream-ended', { streamerId: socket.id });
        }
        if (user.party !== null) {
          parties[user.party].delete(socket.id);
          socket.to(`party-${user.party}`).emit('peer-left', { socketId: socket.id });
        }
        if (user.isBroadcaster) io.emit('broadcaster-left', { socketId: socket.id });
        delete users[socket.id];
        io.emit('party-update', getPartyList());
        io.emit('member-list', getMemberList());
      }
      console.log('Disconnected:', socket.id);
    });
  });
}

module.exports = { registerSocketHandlers };
