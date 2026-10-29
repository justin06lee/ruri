# The iPhone app. `make` builds it and runs it on a simulator; `make demo`
# records the tour against a scratch ruri (demo/record.sh); installing it on
# a phone is Xcode's (README.md says how).

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

.PHONY: all build install test demo boot archive testflight

all: install
	xcrun simctl launch "$(SIM)" $(BUNDLE_ID)

build:
	$(XCODEBUILD) -destination 'generic/platform=iOS Simulator' build

install: build boot
	xcrun simctl install "$(SIM)" $(APP)

test: boot
	$(XCODEBUILD) -destination 'platform=iOS Simulator,name=$(SIM)' test

demo:
	SIM="$(SIM)" demo/record.sh

boot:
	@xcrun simctl bootstatus "$(SIM)" -b >/dev/null
	@open -a Simulator

# TestFlight: an archive signed for the team, uploaded to App Store
# Connect with its API key (never in this repo: ~/.appstoreconnect holds
# it). The build number is the time, so each upload is newer than the last.
# The app's record must exist in App Store Connect first.
TEAM := 65UN46K6FA
ASC_KEY_ID ?= Y688NH26RQ
ASC_ISSUER ?= fd10fb1e-e9c4-4570-bda4-e93f2e10c8ff
ASC_KEY ?= $(HOME)/.appstoreconnect/private_keys/AuthKey_$(ASC_KEY_ID).p8
ASC_AUTH := -allowProvisioningUpdates -authenticationKeyPath $(ASC_KEY) \
	-authenticationKeyID $(ASC_KEY_ID) -authenticationKeyIssuerID $(ASC_ISSUER)
BUILD_NUMBER ?= $(shell date +%Y%m%d%H%M)
ARCHIVE := $(DERIVED)/Ruri.xcarchive

archive:
	xcodebuild -project Ruri.xcodeproj -scheme Ruri -configuration Release -quiet \
	  -destination 'generic/platform=iOS' -archivePath $(ARCHIVE) \
	  DEVELOPMENT_TEAM=$(TEAM) CURRENT_PROJECT_VERSION=$(BUILD_NUMBER) $(ASC_AUTH) archive
	@echo "archived build $(BUILD_NUMBER) at $(ARCHIVE)"

testflight: archive
	xcodebuild -exportArchive -archivePath $(ARCHIVE) -exportOptionsPlist ExportOptions.plist \
	  -exportPath $(DERIVED)/export $(ASC_AUTH)
	@echo "uploaded build $(BUILD_NUMBER) — App Store Connect processes it before TestFlight shows it"
