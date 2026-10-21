# The iPhone app. `make` builds it and runs it on a simulator; installing it
# on a phone is Xcode's (README.md says how).

SIM ?= iPhone 17
BUNDLE_ID := com.justin06lee.ruri.phone
DERIVED := build
APP := $(DERIVED)/Build/Products/Debug-iphonesimulator/Ruri.app

# Xcode, even while xcode-select still points at the command-line tools
DEVELOPER_DIR ?= $(shell p=$$(xcode-select -p); case "$$p" in *CommandLineTools*) \
	x=$$(mdfind "kMDItemCFBundleIdentifier == 'com.apple.dt.Xcode'" | head -1); \
	[ -n "$$x" ] && echo "$$x/Contents/Developer" || echo "$$p";; *) echo "$$p";; esac)
export DEVELOPER_DIR

XCODEBUILD := xcodebuild -project Ruri.xcodeproj -scheme Ruri -derivedDataPath $(DERIVED) -quiet

.PHONY: all build install test boot

all: install
	xcrun simctl launch "$(SIM)" $(BUNDLE_ID)

build:
	$(XCODEBUILD) -destination 'generic/platform=iOS Simulator' build

install: build boot
	xcrun simctl install "$(SIM)" $(APP)

test: boot
	$(XCODEBUILD) -destination 'platform=iOS Simulator,name=$(SIM)' test

boot:
	@xcrun simctl bootstatus "$(SIM)" -b >/dev/null
	@open -a Simulator
