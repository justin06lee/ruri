APP     := ruri
APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app

.PHONY: all build install update launch stop icon tuner

all: build install launch

build:
	bun install
	@test -d node_modules/electron/dist/Electron.app || (cd node_modules/electron && node install.js)
	bun run build

install:
	rm -rf $(APP_DST)
	cp -R $(APP_SRC) $(APP_DST)

update: stop
	rm -rf $(APP_DST)
	$(MAKE) build install launch

launch:
	open $(APP_DST)

stop:
	-pkill -x $(APP) 2>/dev/null || true

icon:
	sh scripts/make-icon.sh

# The art tuner: place the titlebar heads and frame the hero faces by hand.
# Saving writes web/src/peek.ts, which is what the app reads.
tuner:
	@(sleep 2 && open http://localhost:5173/tuner.html) &
	bun run dev:web
