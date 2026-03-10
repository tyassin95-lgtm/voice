const { OWNER_CODE, NUM_PARTIES } = require('../config');
const { users, parties, serializeUser, getPartyList } = require('../state');
const { loadAccounts, saveAccounts } = require('../services/accountService');
const { loadServers, saveServers } = require('../services/serverService');

function registerSocketHandlers(io) {

  // Helper: build a member list scoped to a specific server
  function getMemberListForServer(serverId) {
    const accounts = loadAccounts();
    const servers = loadServers();
    const srv = servers[serverId];
    if (!srv) return [];
    const allowed = new Set([...(srv.members || []), ...(srv.admins || [])]);
    const onlineUsernames = new Set(
      Object.values(users).filter(u => u.username).map(u => u.username.toLowerCase())
    );
    return Object.values(accounts)
      .filter(acc => allowed.has(acc.username.toLowerCase()))
      .map(acc => ({
        username:     acc.username,
        role:         acc.role || 'user',
        avatarUrl:    acc.avatarUrl || '',
        bannerColor:  acc.bannerColor || '#5865f2',
        bio:          acc.bio || '',
        customStatus: acc.customStatus || '',
        online:       onlineUsernames.has(acc.username.toLowerCase())
      }));
  }

  // Broadcast member list only to sockets in the same server
  function broadcastMemberList(serverId) {
    const list = getMemberListForServer(serverId);
    for (const [sid, u] of Object.entries(users)) {
      if (u.serverId === serverId) {
        io.to(sid).emit('member-list', list);
      }
    }
  }

  // Broadcast party list only to sockets in the same server
  function broadcastPartyList(serverId, channels) {
    const partyList = getPartyList(serverId, channels);
    for (const [sid, u] of Object.entries(users)) {
      if (u.serverId === serverId) {
        io.to(sid).emit('party-update', partyList);
      }
    }
  }

  io.on('connection', (socket) => {
    console.log('Connected:', socket.id);
    // Don't send party data or member list on init — client will join a server first
    socket.emit('init', {});

    socket.on('join', ({ username }) => {
      // Look up persistent role from accounts
      const accounts = loadAccounts();
      const acc = accounts[username?.toLowerCase()];
      const role = acc?.role || 'user';
      const autoAdmin = role === 'admin' || role === 'owner';
      users[socket.id] = { username, party: null, serverId: null, isBroadcaster: false, broadcastTargets: 'all', broadcastPaused: false, isAdmin: autoAdmin, serverMuted: false, selfMuted: false, selfDeafened: false, role, avatarUrl: acc?.avatarUrl || '', bannerColor: acc?.bannerColor || '#5865f2', bio: acc?.bio || '' };
      console.log(`${username} joined (role: ${role}${autoAdmin ? ', auto-admin' : ''})`);
      // User's online status changed — broadcast to servers where this user is a member
      const unameLower = username?.toLowerCase();
      if (unameLower) {
        const servers = loadServers();
        for (const [srvId, srv] of Object.entries(servers)) {
          const members = new Set([...(srv.members || []), ...(srv.admins || [])]);
          if (members.has(unameLower)) broadcastMemberList(srvId);
        }
      }
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
      // Broadcast to server if in one
      if (user.serverId) {
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
      // Broadcast updated member list to the user's current server
      if (user.serverId) broadcastMemberList(user.serverId);
    });

    // ── Server: join a server context ──
    socket.on('join-server', ({ serverId }) => {
      const user = users[socket.id];
      if (!user) return;
      const servers = loadServers();
      const srv = servers[serverId];
      if (!srv) return;
      // Verify membership (or owner)
      const uname = user.username.toLowerCase();
      const accounts = loadAccounts();
      const acc = accounts[uname];
      const isOwner = acc?.role === 'owner' || user.role === 'owner';
      if (!isOwner && !srv.members.includes(uname) && !srv.admins.includes(uname)) return;

      // Leave current channel if in one
      if (user.party !== null && user.serverId) {
        const oldKey = user.serverId + ':' + user.party;
        if (parties[oldKey]) parties[oldKey].delete(socket.id);
        socket.leave('party-' + oldKey);
        socket.to('party-' + oldKey).emit('peer-left', { socketId: socket.id });
        // Broadcast update to old server
        const oldSrv = servers[user.serverId];
        if (oldSrv) broadcastPartyList(user.serverId, oldSrv.channels);
      }
      user.party = null;
      user.serverId = serverId;

      // Determine admin status for this server
      const isServerAdmin = isOwner || srv.admins.includes(uname);

      // Build server data for client (strip invite code details for non-admins)
      const serverData = { ...srv };
      if (!isServerAdmin) {
        delete serverData.inviteCodes;
        serverData.pendingRequests = [];
      }

      socket.emit('server-init', {
        server: serverData,
        partyList: getPartyList(serverId, srv.channels)
      });
      // Send scoped member list for this server
      socket.emit('member-list', getMemberListForServer(serverId));
    });

    // ── Server: leave server context ──
    socket.on('leave-server', () => {
      const user = users[socket.id];
      if (!user) return;
      if (user.party !== null && user.serverId) {
        const key = user.serverId + ':' + user.party;
        if (parties[key]) parties[key].delete(socket.id);
        socket.leave('party-' + key);
        socket.to('party-' + key).emit('peer-left', { socketId: socket.id });
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
      user.party = null;
      user.serverId = null;
    });

    socket.on('join-party', ({ serverId, channelId }) => {
      const user = users[socket.id];
      if (!user) return;

      // Verify membership
      const servers = loadServers();
      const srv = servers[serverId];
      if (!srv) return;
      const uname = user.username.toLowerCase();
      const accounts = loadAccounts();
      const acc = accounts[uname];
      const isOwner = acc?.role === 'owner' || user.role === 'owner';
      if (!isOwner && !srv.members.includes(uname) && !srv.admins.includes(uname)) return;

      // Verify channel exists
      if (!srv.channels.find(ch => ch.id === channelId)) return;

      // Leave current party if in one
      if (user.party !== null && user.serverId) {
        const oldKey = user.serverId + ':' + user.party;
        if (parties[oldKey]) parties[oldKey].delete(socket.id);
        socket.leave('party-' + oldKey);
        socket.to('party-' + oldKey).emit('peer-left', { socketId: socket.id });
      }

      user.serverId = serverId;
      user.party = channelId;
      const key = serverId + ':' + channelId;
      if (!parties[key]) parties[key] = new Set();
      parties[key].add(socket.id);
      socket.join('party-' + key);

      const peersInParty = [...parties[key]]
        .filter(sid => sid !== socket.id)
        .map(serializeUser);
      socket.emit('party-peers', { peers: peersInParty, partyId: channelId });
      socket.to('party-' + key).emit('peer-joined', serializeUser(socket.id));
      broadcastPartyList(serverId, srv.channels);
    });

    socket.on('leave-party', () => {
      const user = users[socket.id];
      if (!user || user.party === null) return;
      const key = user.serverId + ':' + user.party;
      if (parties[key]) parties[key].delete(socket.id);
      socket.leave('party-' + key);
      socket.to('party-' + key).emit('peer-left', { socketId: socket.id });
      const servers = loadServers();
      const srv = servers[user.serverId];
      user.party = null;
      if (srv) broadcastPartyList(user.serverId, srv.channels);
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
      if (user.serverId) {
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
    });

    socket.on('set-broadcast-paused', ({ paused }) => {
      const user = users[socket.id];
      if (!user || !user.isBroadcaster) return;
      user.broadcastPaused = paused;
      io.emit('broadcaster-paused', { socketId: socket.id, paused });
      if (user.serverId) {
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
    });

    // ── Owner: verify owner code and persist owner role ──
    socket.on('claim-admin', ({ password }, cb) => {
      if (typeof cb !== 'function') return;
      if (password !== OWNER_CODE) return cb({ ok: false, error: 'Wrong password' });
      const user = users[socket.id];
      if (!user) return cb({ ok: false });

      // Persist owner role
      const accounts = loadAccounts();
      const key = user.username?.toLowerCase();
      if (accounts[key]) {
        accounts[key].role = 'owner';
        saveAccounts(accounts);
      }
      user.role = 'owner';
      user.isAdmin = true;

      // Notify client of role upgrade
      socket.emit('role-admin-granted', { role: 'owner' });
      cb({ ok: true });
    });

    // ── Deprecated: kept for backwards compatibility ──
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
          u.isAdmin = true;
          u.role = 'admin';
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
          u.isAdmin = false;
          u.role = 'user';
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
      if (target.serverId) {
        const servers = loadServers();
        const srv = servers[target.serverId];
        if (srv) broadcastPartyList(target.serverId, srv.channels);
      }
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
    socket.on('admin-move', ({ targetId, toPartyId }) => {
      const admin = users[socket.id];
      if (!admin?.isAdmin) return;
      const target = users[targetId];
      if (!target || !target.serverId) return;

      const serverId = target.serverId;
      const servers = loadServers();
      const srv = servers[serverId];
      if (!srv) return;

      if (target.party !== null) {
        const oldKey = serverId + ':' + target.party;
        if (parties[oldKey]) parties[oldKey].delete(targetId);
        io.to('party-' + oldKey).emit('peer-left', { socketId: targetId });
        const targetSocket = io.sockets.sockets.get(targetId);
        if (targetSocket) targetSocket.leave('party-' + oldKey);
      }

      target.party = toPartyId;
      const newKey = serverId + ':' + toPartyId;
      if (!parties[newKey]) parties[newKey] = new Set();
      parties[newKey].add(targetId);
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.join('party-' + newKey);
        const peersInParty = [...parties[newKey]]
          .filter(sid => sid !== targetId)
          .map(serializeUser);
        targetSocket.emit('party-peers', { peers: peersInParty, partyId: toPartyId });
        targetSocket.to('party-' + newKey).emit('peer-joined', serializeUser(targetId));
        targetSocket.emit('admin-moved', { by: admin.username, toPartyId });
      }

      broadcastPartyList(serverId, srv.channels);
      console.log(`[ADMIN] ${admin.username} moved ${target.username} to channel ${toPartyId}`);
    });

    // ── Admin: remove member from server (after REST call) ──
    socket.on('admin-remove-from-server', ({ targetUsername }) => {
      const admin = users[socket.id];
      if (!admin?.isAdmin) return;
      const tname = targetUsername?.toLowerCase();
      for (const [sid, u] of Object.entries(users)) {
        if (u.username?.toLowerCase() === tname) {
          io.to(sid).emit('server-member-removed');
        }
      }
    });

    // ── User: update self-mute state ──
    socket.on('set-self-muted', ({ muted }) => {
      const user = users[socket.id];
      if (!user) return;
      user.selfMuted = muted;
      if (user.serverId) {
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
    });

    // ── User: update self-deafen state ──
    socket.on('set-self-deafened', ({ deafened }) => {
      const user = users[socket.id];
      if (!user) return;
      user.selfDeafened = deafened;
      if (deafened) user.selfMuted = true;
      if (user.serverId) {
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (srv) broadcastPartyList(user.serverId, srv.channels);
      }
    });

    // ── Latency: respond to ping-check so client can measure RTT ──
    socket.on('ping-check', (cb) => {
      if (typeof cb === 'function') cb();
    });

    // ── Latency: relay a user's reported latency to their party ──
    socket.on('latency-report', ({ latency }) => {
      const user = users[socket.id];
      if (!user || user.party === null || !user.serverId) return;
      const key = user.serverId + ':' + user.party;
      socket.to('party-' + key).volatile.emit('latency-update', { socketId: socket.id, latency });
    });

    // ── Audio relay ──
    socket.on('audio-chunk', (chunk) => {
      const user = users[socket.id];
      if (!user || user.serverMuted) return;

      if (user.isBroadcaster) {
        if (user.party === null || !user.serverId) return;

        if (user.broadcastPaused) {
          const key = user.serverId + ':' + user.party;
          socket.to('party-' + key).volatile.emit('audio-from', { from: socket.id, chunk });
          return;
        }

        const targets = user.broadcastTargets;
        const servers = loadServers();
        const srv = servers[user.serverId];
        if (!srv) return;

        if (targets === 'all') {
          for (const ch of srv.channels) {
            const key = user.serverId + ':' + ch.id;
            socket.to('party-' + key).volatile.emit('audio-from', { from: socket.id, chunk });
          }
        } else if (Array.isArray(targets)) {
          for (const channelId of targets) {
            const key = user.serverId + ':' + channelId;
            socket.to('party-' + key).volatile.emit('audio-from', { from: socket.id, chunk });
          }
        }
        return;
      }

      if (user.party !== null && user.serverId) {
        const key = user.serverId + ':' + user.party;
        socket.to('party-' + key).volatile.emit('audio-from', { from: socket.id, chunk });
      }
    });

    socket.on('disconnect', () => {
      const user = users[socket.id];
      if (user) {
        if (user.party !== null && user.serverId) {
          const key = user.serverId + ':' + user.party;
          if (parties[key]) parties[key].delete(socket.id);
          socket.to('party-' + key).emit('peer-left', { socketId: socket.id });
          const servers = loadServers();
          const srv = servers[user.serverId];
          if (srv) broadcastPartyList(user.serverId, srv.channels);
        }
        if (user.isBroadcaster) io.emit('broadcaster-left', { socketId: socket.id });
        const unameLower = user.username?.toLowerCase();
        delete users[socket.id];
        // User went offline — broadcast to all servers where they are a member
        if (unameLower) {
          const servers = loadServers();
          for (const [srvId, srv] of Object.entries(servers)) {
            const members = new Set([...(srv.members || []), ...(srv.admins || [])]);
            if (members.has(unameLower)) broadcastMemberList(srvId);
          }
        }
      }
      console.log('Disconnected:', socket.id);
    });
  });
}

module.exports = { registerSocketHandlers };
