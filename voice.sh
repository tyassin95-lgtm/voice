#!/bin/bash
# OathlyVoice - Start/Stop helper
# Usage: ./voice.sh start | stop | status | restart

ACTION=${1:-status}
APP_NAME="oathlyvoice"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

case $ACTION in
  start)
    echo "Starting OathlyVoice..."
    pm2 start "$APP_DIR/server.js" --name "$APP_NAME" --time
    pm2 save
    echo "✓ OathlyVoice is running at https://oathly.net/voice"
    ;;
  stop)
    echo "Stopping OathlyVoice..."
    pm2 stop "$APP_NAME"
    pm2 save
    echo "✓ OathlyVoice is offline. https://oathly.net/voice will show the offline page."
    ;;
  restart)
    pm2 restart "$APP_NAME"
    echo "✓ Restarted."
    ;;
  status)
    pm2 show "$APP_NAME" 2>/dev/null || echo "OathlyVoice is not running."
    ;;
  *)
    echo "Usage: $0 start|stop|restart|status"
    ;;
esac
