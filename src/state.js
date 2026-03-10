const { NUM_PARTIES } = require('./config');

// socketId -> { username, party, serverId, isBroadcaster, isAdmin, serverMuted, selfMuted, selfDeafened }
const users   = {};
// String-keyed: "serverId:channelId" -> Set of socketIds
const parties = {};

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
    selfDeafened:     u?.selfDeafened       || false,
    avatarUrl:        u?.avatarUrl         || '',
    bannerColor:      u?.bannerColor       || '#5865f2',
    bio:              u?.bio               || ''
  };
}

function getPartyList(serverId, channels) {
  const result = {};
  if (!channels) return result;
  for (const ch of channels) {
    const key = serverId + ':' + ch.id;
    result[ch.id] = [...(parties[key] || [])].map(serializeUser);
  }
  return result;
}

module.exports = { users, parties, serializeUser, getPartyList };
