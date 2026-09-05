APP     := ruri
APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app
APP_KEEP := /tmp/$(APP)-superseded

.PHONY: all build install update relaunch launch stop stop-all icon tuner

all: build install launch

build:
	bun install --cwd ../yagami
	bun run --cwd ../yagami build
	bun install
	@test -d node_modules/electron/dist/Electron.app || (cd node_modules/electron && node install.js)
	bun run build

# Never delete the bundle of a running app. On macOS that pulls its
# executable and resources out from under it and it dies on the spot — and
# since ruri is where its own sessions run, the app being replaced is
# routinely the one that asked for the replacement. (It is also why `stop`
# below is not a dependency of this: quitting ruri from inside ruri closes
# the session doing the quitting.)
#
# So the old bundle is moved aside instead of removed. A rename keeps its
# inode, so a running instance keeps every file it already has open and
# carries on; the new version is simply there the next time it launches.
# Superseded bundles pile up under $(APP_KEEP) and are swept whenever an
# install happens with nothing running — never while something might still
# be reading one.
install:
	@mkdir -p $(APP_KEEP)
	@pgrep -x $(APP) >/dev/null 2>&1 || rm -rf $(APP_KEEP)/*
	@test -d $(APP_DST) && mv $(APP_DST) $(APP_KEEP)/`date +%Y%m%d-%H%M%S`.app || true
	cp -R $(APP_SRC) $(APP_DST)
	@echo "installed $(APP_DST) — relaunch ruri to pick it up"

# An update never touches a session. The app and the server are two
# processes: `install` puts the new bundle in place, `relaunch` swaps the
# app (the window) for the new one, and the server keeps running underneath
# with every session in it. The new app tells the old server a newer one is
# here; it steps aside the moment every session is idle, and the new app
# starts the new server in its place. Idle sessions resume from the
# archive; nothing mid-turn is interrupted.
update:
	$(MAKE) build install relaunch

relaunch:
	@osascript -e 'tell application "$(APP)" to quit' >/dev/null 2>&1 || true
	@for i in $$(seq 1 30); do pgrep -f "$(APP).app/Contents/MacOS/$(APP)$$" >/dev/null 2>&1 || break; sleep 0.2; done
	open $(APP_DST)

launch:
	open $(APP_DST)

# `stop` quits the app — the window — and leaves the server, and every
# session in it, running. `stop-all` takes the server down too: quit, don't
# kill — it writes transcripts and drafts on a debounce, and a SIGKILL loses
# whatever hadn't landed yet — so it gets SIGTERM and a moment to flush.
#
# Run `stop-all` from a terminal, not from a ruri session — it closes the
# server the session is living in, which takes the session with it.
stop:
	@osascript -e 'tell application "$(APP)" to quit' >/dev/null 2>&1 || true
	@for i in $$(seq 1 30); do pgrep -f "$(APP).app/Contents/MacOS/$(APP)$$" >/dev/null 2>&1 || break; sleep 0.2; done

stop-all: stop
	@pkill -TERM -f "dist-electron/server.mjs" >/dev/null 2>&1 || true
	@for i in $$(seq 1 50); do pgrep -f "dist-electron/server.mjs" >/dev/null 2>&1 || break; sleep 0.2; done
	@pgrep -f "dist-electron/server.mjs" >/dev/null 2>&1 && pkill -KILL -f "dist-electron/server.mjs" >/dev/null 2>&1 || true

icon:
	sh scripts/make-icon.sh

# The art tuner: place the titlebar heads and frame the hero faces by hand.
# Saving writes web/src/peek.ts, which is what the app reads.
tuner:
	@(sleep 2 && open http://localhost:5173/tuner.html) &
	bun run dev:web
