APP     := ruri
APP_SRC := dist-app/mac-arm64/$(APP).app
APP_DST := /Applications/$(APP).app

.PHONY: all build install update launch stop icon

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
