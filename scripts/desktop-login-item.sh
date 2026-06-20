#!/bin/bash
# Install/remove the Campaigns menu-bar login item.

set -euo pipefail

ACTION="${1:-status}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/app-it.config.json"

read_config() {
    /usr/bin/python3 - "$CONFIG_FILE" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    app = json.load(f)["apps"][0]
print(app["name"])
print(app["bundle_id"])
PY
}

CONFIG_RAW="$(read_config)"
APP_NAME="$(printf '%s\n' "$CONFIG_RAW" | sed -n '1p')"
BUNDLE_ID="$(printf '%s\n' "$CONFIG_RAW" | sed -n '2p')"
LABEL="${BUNDLE_ID}.menu-bar"
APP_PATH="${CAMPAIGNS_APP_PATH:-$HOME/Applications/App It/$APP_NAME.app}"
RUN_BIN="$APP_PATH/Contents/MacOS/run"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/app-it/campaigns"
DOMAIN="gui/$(id -u)"

install_item() {
    if [ ! -x "$RUN_BIN" ]; then
        echo "Installed app missing: $APP_PATH" >&2
        echo "Run: npm run desktop:build && npm run desktop:install" >&2
        exit 1
    fi

    mkdir -p "$PLIST_DIR" "$LOG_DIR"
    launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true

    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$RUN_BIN</string>
        <string>--menu-bar</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/login-item.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/login-item.err.log</string>
</dict>
</plist>
PLIST

    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    echo "Installed login item: $LABEL"
    echo "Menu-bar app: $APP_PATH"
}

uninstall_item() {
    launchctl bootout "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    echo "Removed login item: $LABEL"
}

status_item() {
    if [ -f "$PLIST" ]; then
        echo "Installed: $PLIST"
    else
        echo "Not installed: $LABEL"
        exit 1
    fi

    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "Loaded: yes"
    else
        echo "Loaded: no"
    fi
}

case "$ACTION" in
    install) install_item ;;
    uninstall|remove) uninstall_item ;;
    status) status_item ;;
    *)
        echo "Usage: $0 install|uninstall|status" >&2
        exit 2
        ;;
esac
