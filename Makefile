APP     := ruri
APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app
APP_KEEP := /tmp/$(APP)-superseded
BUNDLE_ID := com.justin06lee.ruri

.PHONY: all build install update launch stop icon tuner reset-permissions

all: build reset-permissions install launch

build:
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

update: stop
	$(MAKE) build reset-permissions install launch

# macOS ties every privacy grant (Accessibility, Screen Recording, the
# folders and volumes) to the app's code signature, and an ad-hoc-signed
# app is re-signed by every build — so the grants made to the last build
# are void for this one while their switches in System Settings still read
# "on". The stale rows are dropped here, for ruri's bundle id only, and the
# new build asks for everything again on its first launch
# (desktop/permissions.ts). System Settings is quit first: it caches the
# table, and an open pane hides the reset.
reset-permissions:
	-osascript -e 'quit app "System Settings"' >/dev/null 2>&1
	-tccutil reset All $(BUNDLE_ID) >/dev/null 2>&1
	@echo "reset macOS grants for $(BUNDLE_ID) — the next launch asks again"

launch:
	open $(APP_DST)

# Quit, don't kill: ruri writes transcripts and drafts on a debounce, and a
# SIGKILL loses whatever hadn't landed yet. The kill is only the last resort
# for an app that has stopped answering.
#
# Run this from a terminal, not from a ruri session — it closes the app the
# session is living in, which takes the session with it.
stop:
	@osascript -e 'tell application "$(APP)" to quit' >/dev/null 2>&1 || true
	@for i in $$(seq 1 30); do pgrep -x $(APP) >/dev/null 2>&1 || break; sleep 0.2; done
	@pgrep -x $(APP) >/dev/null 2>&1 && pkill -x $(APP) >/dev/null 2>&1 || true

icon:
	sh scripts/make-icon.sh

# The art tuner: place the titlebar heads and frame the hero faces by hand.
# Saving writes web/src/peek.ts, which is what the app reads.
tuner:
	@(sleep 2 && open http://localhost:5173/tuner.html) &
	bun run dev:web
