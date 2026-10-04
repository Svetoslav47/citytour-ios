#!/usr/bin/env bash
# Builds the iOS debug app (dev client + CityTourWidget extension) for the simulator and installs it.
# Usage: scripts/ios-build.sh [simulator name or UDID]   (default: the booted simulator)
# Needs Xcode 16.x and CocoaPods. ios/ is generated (Continuous Native Generation): never edit it by hand.
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # CocoaPods fails on a non-UTF-8 locale
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
DEVICE="${1:-booted}"
if [ "$DEVICE" = "booted" ]; then
  UDID="$(xcrun simctl list devices booted | grep -Eo '[0-9A-F-]{36}' | head -1)"
else
  UDID="$(xcrun simctl list devices available | grep -F "$DEVICE" | grep -Eo '[0-9A-F-]{36}' | head -1)"
  [ -n "$UDID" ] && xcrun simctl boot "$UDID" 2>/dev/null || true
fi
[ -n "${UDID:-}" ] || { echo "No simulator found (boot one or pass its name)"; exit 1; }
# --clean: @bacons/apple-targets fails on an incremental prebuild of an existing widget target.
npx expo prebuild -p ios --clean
xcodebuild -workspace ios/CityTour.xcworkspace -scheme CityTour -configuration Debug -sdk iphonesimulator \
  -destination "id=$UDID" -derivedDataPath ios/build build | grep -E 'error:|BUILD (SUCCEEDED|FAILED)'
xcrun simctl install "$UDID" ios/build/Build/Products/Debug-iphonesimulator/CityTour.app
echo "IOS_BUILD: PASS installed on $UDID"
