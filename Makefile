APP     := ruri

# macOS builds a signed .app for /Applications; Linux, an unpacked build
# under ~/.local with a .desktop entry. `make` is the golden path on both.
ifeq ($(shell uname -s),Darwin)

APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app
APP_KEEP := /tmp/$(APP)-superseded
BUNDLE_ID := com.justin06lee.ruri

# The code-signing identity every build is signed with — a self-signed
# certificate in the login keychain, made once by `make identity`. macOS
# ties privacy grants to the signature, so a stable one keeps them across
# rebuilds; an ad-hoc signature is new every build and voids them.
IDENTITY := ruri dev
KEYCHAIN := $(HOME)/Library/Keychains/login.keychain-db
HAVE_IDENTITY = security find-identity -v -p codesigning 2>/dev/null | grep -q '"$(IDENTITY)"'

# The privacy services ruri asks for (desktop/permissions.ts), by tccutil's
# names — reset only on an ad-hoc build, and only these, never All.
TCC_SERVICES := Accessibility ScreenCapture AppleEvents SystemPolicyAllFiles \
  SystemPolicyDesktopFolder SystemPolicyDocumentsFolder SystemPolicyDownloadsFolder \
  SystemPolicyRemovableVolumes SystemPolicyNetworkVolumes

# The running ruri's pid(s), found by the path it was started from. A name
# match (pgrep -x) does not see it, which left every check below believing
# ruri was never running.
RUNNING = ps -Ao pid=,comm= | awk '$$2 ~ /\/MacOS\/$(APP)$$/ {print $$1}'

.PHONY: all build install update launch stop icon identity reset-permissions sweep-superseded tidy

all: build reset-permissions install tidy launch

# Signed with the identity when it exists, ad-hoc when it does not (the
# identity is made first; a refused keychain prompt falls back to ad-hoc
# rather than stopping the build).
build:
	bun install
	@test -d node_modules/electron/dist/Electron.app || (cd node_modules/electron && node install.js)
	-@$(MAKE) --no-print-directory identity
	@if $(HAVE_IDENTITY); then \
	  echo "signing as '$(IDENTITY)'"; CSC_NAME="$(IDENTITY)" bun run build; \
	else \
	  echo "no '$(IDENTITY)' identity — ad-hoc signature (grants will not survive this build)"; \
	  CSC_IDENTITY_AUTO_DISCOVERY=false bun run build; \
	fi

# A self-signed code-signing certificate named "$(IDENTITY)" in the login
# keychain, made once and trusted for code signing by this user (no sudo,
# no Apple account — and so no notarization; see docs/permissions.md).
# Idempotent: an identity that is already there is left alone. Apple's own
# openssl (LibreSSL) writes a PKCS#12 the keychain can import; a newer
# Homebrew OpenSSL's default ciphers are refused by `security import`.
identity:
	@if $(HAVE_IDENTITY); then echo "signing identity '$(IDENTITY)' is in the login keychain"; exit 0; fi; \
	set -e; tmp=$$(mktemp -d); \
	printf '[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = $(IDENTITY)\n[ext]\nbasicConstraints = critical, CA:false\nkeyUsage = critical, digitalSignature\nextendedKeyUsage = critical, codeSigning\n' > $$tmp/cert.cnf; \
	/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config $$tmp/cert.cnf -keyout $$tmp/key.pem -out $$tmp/cert.pem 2>/dev/null; \
	/usr/bin/openssl pkcs12 -export -inkey $$tmp/key.pem -in $$tmp/cert.pem -name "$(IDENTITY)" -passout pass:$(APP) -out $$tmp/identity.p12; \
	security import $$tmp/identity.p12 -k $(KEYCHAIN) -P $(APP) -T /usr/bin/codesign -T /usr/bin/security >/dev/null; \
	security add-trusted-cert -r trustRoot -p codeSign -k $(KEYCHAIN) $$tmp/cert.pem; \
	rm -rf $$tmp; \
	if $(HAVE_IDENTITY); then echo "created signing identity '$(IDENTITY)' in the login keychain"; \
	else echo "identity '$(IDENTITY)' was imported but is not valid for code signing — was the trust prompt refused?"; exit 1; fi

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

# macOS ties every privacy grant (Accessibility, Screen Recording, the
# folders and volumes) to the app's code signature. Signed with the stable
# identity, a new build is the same app to macOS and its grants carry over,
# so there is nothing to reset. Only an ad-hoc build — no identity, so a
# new signature every time — has its stale rows dropped here: ruri's bundle
# id only, and only the services ruri uses; the new build asks for each
# again on its first launch (desktop/permissions.ts). System Settings is
# quit first: it caches the table, and an open pane hides the reset.
reset-permissions:
	@if $(HAVE_IDENTITY); then echo "signed as '$(IDENTITY)' — macOS grants carry over, nothing to reset"; exit 0; fi; \
	osascript -e 'quit app "System Settings"' >/dev/null 2>&1; \
	for s in $(TCC_SERVICES); do tccutil reset $$s $(BUNDLE_ID) >/dev/null 2>&1; done; \
	echo "ad-hoc build: reset macOS grants for $(BUNDLE_ID) — the next launch asks again"

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
	bun scripts/draw-icon.ts
	sh scripts/make-icon.sh

else
# ── Linux ───────────────────────────────────────────────────────────────
#
# The same golden path on a Linux desktop (GNOME, or anything that reads
# .desktop entries): an unpacked Electron build installed for this user
# alone under ~/.local — no package manager, no root for the app itself —
# with a .desktop entry and the icon, so it sits in the app grid and the
# dock like anything else. There is no signature for grants to hang on and
# no grants to reset; the one step that needs root is the sandbox profile
# (below), made once.

# electron-builder names its unpacked folder by architecture
APP_SRC := dist-app/$(if $(filter aarch64 arm64,$(shell uname -m)),linux-arm64-unpacked,linux-unpacked)
APP_DST := $(HOME)/.local/opt/$(APP)
# Beside the install, not in /tmp: a rename keeps a running ruri's files
# only on the same filesystem, and /tmp is often another one.
APP_KEEP := $(HOME)/.local/opt/$(APP)-superseded
DESKTOP_FILE := $(HOME)/.local/share/applications/$(APP).desktop
ICON_FILE := $(HOME)/.local/share/icons/hicolor/scalable/apps/$(APP).svg
APPARMOR := /etc/apparmor.d/$(APP)

# The running ruri's main process: started from the installed build (or a
# superseded one), and not one of Chromium's helpers, which run the same
# executable with a --type.
RUNNING = for p in $$(pgrep -x $(APP) 2>/dev/null); do \
  case "$$(readlink /proc/$$p/exe 2>/dev/null)" in $(APP_DST)/$(APP)|$(APP_KEEP)/*) ;; *) continue ;; esac; \
  tr '\0' ' ' < /proc/$$p/cmdline 2>/dev/null | grep -q -- '--type=' || echo $$p; \
done

.PHONY: all build install update launch stop sandbox apparmor-profile desktop-entry linux-deps sweep-superseded tidy

all: build install tidy launch

build:
	bun install
	@test -x node_modules/electron/dist/electron || (cd node_modules/electron && node install.js)
	bun run build

# Moved aside, never deleted, for the same reason as on macOS: a running
# ruri is usually the one whose session asked for the new build, and a
# rename keeps every file it has open.
install: sweep-superseded sandbox linux-deps
	@mkdir -p $(dir $(APP_DST)) $(APP_KEEP)
	@test -d $(APP_DST) && mv $(APP_DST) $(APP_KEEP)/`date +%Y%m%d-%H%M%S` || true
	cp -R $(APP_SRC) $(APP_DST)
	@$(MAKE) --no-print-directory desktop-entry
	@echo "installed $(APP_DST) — in the app grid as ruri; relaunch ruri to pick it up"

# The app grid's entry and its icon (the SVG, which GNOME draws at every
# size). StartupWMClass is what ties the window to the entry, so the dock
# shows ruri's icon rather than a generic one.
desktop-entry:
	@mkdir -p $(dir $(DESKTOP_FILE)) $(dir $(ICON_FILE))
	@cp build/icon.svg $(ICON_FILE)
	@printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=ruri' \
	  'Comment=One desktop workspace for all your projects, each a folder of live coding sessions' \
	  'Exec=$(APP_DST)/$(APP)' 'Icon=$(APP)' 'Terminal=false' 'Categories=Development;' \
	  'StartupWMClass=$(APP)' 'StartupNotify=true' > $(DESKTOP_FILE)
	@command -v update-desktop-database >/dev/null && update-desktop-database $(dir $(DESKTOP_FILE)) 2>/dev/null || true

# Ubuntu 24.04 and later let no program make a user namespace unless an
# AppArmor profile allows it, and Chromium's sandbox is built on one — so
# without this Electron stops at launch ("The SUID sandbox helper binary
# was found, but is not configured correctly"). This is the profile a
# .deb would install, for ruri's own path (and its superseded copies, which
# a running ruri may still start helpers from). Written with sudo once and
# left alone while it says the same; skipped where namespaces are not
# restricted.
sandbox:
	@[ "$$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || exit 0; \
	want=$$($(MAKE) -s --no-print-directory apparmor-profile); \
	[ "$$(cat $(APPARMOR) 2>/dev/null)" = "$$want" ] && exit 0; \
	echo "ruri's sandbox needs an AppArmor profile on this system — installing $(APPARMOR) (sudo, once)"; \
	printf '%s\n' "$$want" | sudo tee $(APPARMOR) >/dev/null && sudo apparmor_parser -r $(APPARMOR) || { \
	  echo "could not install $(APPARMOR) — run make again from a terminal where sudo can ask for your password"; exit 1; }

# What macOS has built in and a Linux desktop may not: expect (the pty under
# the composer's terminals — server/terminal.ts), curl (the `ruri` command
# sessions run), and the bridge's hands for native apps — xdotool and
# wmctrl for windows, python3's GObject bindings to speak AT-SPI to their
# controls and xprop to find the display's accessibility bus, ImageMagick
# for pictures off the X server. Installed with apt when it is there (sudo,
# only when something is missing); elsewhere, named.
LINUX_DEPS := expect:expect curl:curl xdotool:xdotool wmctrl:wmctrl xprop:x11-utils import:imagemagick
linux-deps:
	@missing=""; \
	for d in $(LINUX_DEPS); do command -v $${d%%:*} >/dev/null 2>&1 || missing="$$missing $${d#*:}"; done; \
	python3 -c 'from gi.repository import Gio' 2>/dev/null || missing="$$missing python3-gi"; \
	[ -z "$$missing" ] && exit 0; \
	if command -v apt-get >/dev/null 2>&1; then \
	  echo "installing what ruri uses on Linux:$$missing (sudo)"; \
	  sudo apt-get install -y $$missing || echo "could not install$$missing — terminals or the bridge's native apps will say what they lack"; \
	else echo "ruri would like:$$missing — install them with your package manager"; fi

apparmor-profile:
	@printf '%s\n' 'abi <abi/4.0>,' 'include <tunables/global>' '' \
	  'profile $(APP) $(APP_DST){,-superseded/*}/$(APP) flags=(unconfined) {' '  userns,' \
	  '  include if exists <local/$(APP)>' '}'

update: stop
	$(MAKE) build install tidy launch

launch:
	@setsid -f $(APP_DST)/$(APP) >/dev/null 2>&1 < /dev/null

# SIGTERM is a quit here (desktop/main.ts): the teardown runs and the
# archive's pending writes land. KILL only for one that stops answering.
# Like on macOS, not from a ruri session — it closes the app the session
# lives in.
stop:
	@p=$$($(RUNNING)); [ -n "$$p" ] || exit 0; kill $$p 2>/dev/null; \
	for i in $$(seq 1 50); do [ -z "$$($(RUNNING))" ] && exit 0; sleep 0.2; done; \
	p=$$($(RUNNING)); [ -n "$$p" ] && kill -9 $$p 2>/dev/null || true

# A superseded build goes the moment no running ruri was started from it.
sweep-superseded:
	@live=$$(for p in $$($(RUNNING)); do readlink /proc/$$p/exe; done); \
	for b in $(APP_KEEP)/*; do \
	  [ -d "$$b" ] || continue; \
	  printf '%s\n' $$live | grep -qx "$$b/$(APP)" && continue; \
	  rm -rf "$$b"; \
	done

endif

# What earlier runs and older versions left behind and nothing reads any
# more: the test scripts' scratch directories (an hour old or more, so a
# test running now keeps its own) and a server log no version writes now.
# ruri tidies its own data at launch (server/orphans.ts, desktop/main.ts).
tidy:
	@find /tmp "$${TMPDIR:-/tmp}" -maxdepth 1 -name '$(APP)-*' ! -name '$(APP)-superseded' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
	@rm -f "$${RURI_CONFIG_DIR:-$(HOME)/.config/ruri}/server.log"

