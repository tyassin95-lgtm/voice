const path = require('path');

const OWNER_CODE    = 'OathGuild@1995';
const NUM_PARTIES   = 12;
const ACCOUNTS_FILE = path.join(__dirname, '..', 'accounts.json');

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

module.exports = { OWNER_CODE, NUM_PARTIES, ACCOUNTS_FILE, defaultSettings };
