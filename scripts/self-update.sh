#!/bin/sh
# `make self-update`'s second half: the build is done and signed; put it in
# /Applications from outside ruri, so a chat running inside ruri can ask for
# it without quitting the app it runs in under itself.
#
# The new bundle is staged in ~/Library/Caches/ruri-update (no part of it on
# the repo's volume: a launchd job has none of ruri's privacy grants, an
# external drive's folders among them). A one-shot launchd job, outside
# ruri's process tree, then waits until no chat is at work (ruri's /status,
# for up to 30 minutes), quits ruri the way `make stop` does — gently, so
# chats mid-turn are carried on after the relaunch — swaps the bundle in,
# opens it, and takes itself out. Its log: ~/Library/Caches/ruri-update/update.log.
#
#   sh scripts/self-update.sh <built ruri.app>
set -eu

SRC=${1:?the built ruri.app}
DIR="$HOME/Library/Caches/ruri-update"
LABEL=codes.ruri.self-update
PLIST="$DIR/$LABEL.plist"
DST=/Applications/ruri.app

mkdir -p "$DIR"
rm -rf "$DIR/ruri.app"
ditto "$SRC" "$DIR/ruri.app"

cat > "$DIR/swap.sh" <<'EOF'
#!/bin/sh
DIR="$HOME/Library/Caches/ruri-update"
LOG="$DIR/update.log"
say() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }
running() { ps -Ao pid=,comm= | awk '$2 ~ /\/MacOS\/ruri$/ {print $1}'; }

say "waiting for every chat to be still"
token=$(cat "$HOME/.config/ruri/token" 2>/dev/null || true)
# ruri's port: 7777, or the next one up when that was taken
port=7777
for p in 7777 7776 7778 7779 7780; do
  case "$(curl -s -m 2 "http://127.0.0.1:$p/healthz")" in *'"service":"ruri"'*) port=$p; break ;; esac
done
i=0
while [ $i -lt 360 ]; do
  status=$(curl -s -m 5 -H "x-ruri-token: $token" "http://127.0.0.1:$port/status" || true)
  case "$status" in
    *'"working"'*) sleep 5; i=$((i + 1)) ;;
    *) break ;;
  esac
done
[ $i -ge 360 ] && say "still at work after 30 minutes: updating anyway (chats carry on after the relaunch)"

say "quitting ruri"
osascript -e 'tell application "ruri" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 50); do [ -z "$(running)" ] && break; sleep 0.2; done
p=$(running); [ -n "$p" ] && kill $p >/dev/null 2>&1 && sleep 1

mkdir -p /tmp/ruri-superseded
[ -d /Applications/ruri.app ] && mv /Applications/ruri.app "/tmp/ruri-superseded/$(date +%Y%m%d-%H%M%S).app"
if mv "$DIR/ruri.app" /Applications/ruri.app; then say "installed"; else say "install failed: putting the old one back"; fi
[ -d /Applications/ruri.app ] || mv "$(ls -dt /tmp/ruri-superseded/*.app | head -1)" /Applications/ruri.app
open /Applications/ruri.app && say "relaunched"
launchctl bootout "gui/$(id -u)/codes.ruri.self-update" >/dev/null 2>&1
EOF

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$DIR/swap.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/update.log</string>
  <key>StandardErrorPath</key><string>$DIR/update.log</string>
</dict></plist>
EOF

: > "$DIR/update.log"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "staged; ruri updates as soon as no chat is at work (log: $DIR/update.log) — relaunching ends this turn, and it carries on after"
