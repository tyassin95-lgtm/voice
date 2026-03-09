const { NUM_PARTIES } = require('./config');

// socketId -> { username, party, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened }
const users   = {};
const parties = {};
for (let i = 1; i <= NUM_PARTIES; i++) parties[i] = new Set();

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

function getPartyList() {
  const result = {};
  for (let i = 1; i <= NUM_PARTIES; i++) {
    result[i] = [...parties[i]].map(serializeUser);
  }
  return result;
}

module.exports = { users, parties, serializeUser, getPartyList };
