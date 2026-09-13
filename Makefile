APP     := ruri
APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app
APP_KEEP := /tmp/$(APP)-superseded
BUNDLE_ID := com.justin06lee.ruri

# The running ruri's pid(s), found by the path it was started from. A name
# match (pgrep -x) does not see it, which left every check below believing
# ruri was never running.
RUNNING = ps -Ao pid=,comm= | awk '$$2 ~ /\/MacOS\/$(APP)$$/ {print $$1}'

.PHONY: all build install update launch stop icon tuner reset-permissions sweep-superseded tidy

all: build reset-permissions install tidy launch

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
# Superseded bundles are swept on every install — all but one a running
# ruri was started from (sweep-superseded).
install: sweep-superseded
	@mkdir -p $(APP_KEEP)
	@test -d $(APP_DST) && mv $(APP_DST) $(APP_KEEP)/`date +%Y%m%d-%H%M%S`.app || true
	cp -R $(APP_SRC) $(APP_DST)
	@echo "installed $(APP_DST) — relaunch ruri to pick it up"

update: stop
	$(MAKE) build reset-permissions install tidy launch

# A superseded bundle goes the moment no running ruri was started from it.
# Matched by the executable's inode: a moved bundle keeps its inode, while
# the path a process reports is the one it was launched under. When a ruri
# is running but its executable cannot be read (no lsof), nothing is swept.
sweep-superseded:
	@pids=$$($(RUNNING)); \
	live=$$(for p in $$pids; do lsof -p $$p -a -d txt -Fi 2>/dev/null | sed -n 's/^i//p' | head -1; done); \
	if [ -n "$$pids" ] && [ -z "$$live" ]; then exit 0; fi; \
	for b in $(APP_KEEP)/*.app; do \
	  [ -d "$$b" ] || continue; \
	  i=$$(stat -f %i "$$b/Contents/MacOS/$(APP)" 2>/dev/null); \
	  if [ -n "$$i" ] && printf '%s\n' $$live | grep -qx "$$i"; then continue; fi; \
	  rm -rf "$$b"; \
	done

# What earlier runs and older versions left behind and nothing reads any
# more: the test scripts' scratch directories (an hour old or more, so a
# test running now keeps its own) and a server log no version writes now.
# ruri tidies its own data at launch (server/orphans.ts, desktop/main.ts).
tidy:
	@find /tmp "$${TMPDIR:-/tmp}" -maxdepth 1 -name '$(APP)-*' ! -name '$(APP)-superseded' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
	@rm -f "$${RURI_CONFIG_DIR:-$(HOME)/.config/ruri}/server.log"

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
# SIGKILL loses whatever hadn't landed yet. The TERM is only the last resort
# for an app that has stopped answering.
#
# Run this from a terminal, not from a ruri session — it closes the app the
# session is living in, which takes the session with it.
stop:
	@osascript -e 'tell application "$(APP)" to quit' >/dev/null 2>&1 || true
	@for i in $$(seq 1 30); do [ -z "$$($(RUNNING))" ] && break; sleep 0.2; done
	@p=$$($(RUNNING)); [ -n "$$p" ] && kill $$p >/dev/null 2>&1 || true

icon:
	sh scripts/make-icon.sh

# The art tuner: place the titlebar heads and frame the hero faces by hand.
# Saving writes web/src/peek.ts, which is what the app reads.
tuner:
	@(sleep 2 && open http://localhost:5173/tuner.html) &
	bun run dev:web
