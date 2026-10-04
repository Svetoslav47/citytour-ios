# CityTour for iOS

> The iOS port of [CityTour](https://github.com/Svetoslav47/citytour) (HackYeah 2026, originally a native
> ArkTS/ArkUI app for HarmonyOS). Expo SDK 54 · React Native 0.81 · TypeScript, with the same Express + TypeScript
> course server.

CityTour is a mobile tour guide that follows you through the city. It tracks where you are and which way you are
walking. When you reach a place of historic or cultural significance, it explains that place to you in a studio
voice, in English, Polish or Chinese.

The app ships no built-in course. Home lists the walks the course server publishes for Kraków (the Royal Route,
Scholars and Saints, Kazimierz). **Start** or **Demo walk** streams a walk (about 2.5 MB, the clips are fetched on
demand); the download button keeps it fully offline (pack + 1155 studio-voice clips, about 40 MB, every file
Ed25519-signed and SHA-256-checked).

## What was ported

Everything except two parts dropped by decision: the **Apple Watch / wearable app** and the **built-in system
text-to-speech voice**. How each piece maps is in [`docs/PORTING.md`](docs/PORTING.md).

| Area | HarmonyOS original | This repo |
| --- | --- | --- |
| Shared logic: geo, Held-Karp / orienteering planner, tour engine, triggers, turn-by-turn, off-route, narration selection and validation, voice chain, course rules, widget/notification text | `common/` HAR (ArkTS) | [`core/`](core/) (`@citytour/core`, plain TypeScript, logic unchanged) |
| Unit tests | 438 hypium tests | 445 vitest cases in [`core/test/`](core/test/) incl. the Replay integration test, plus app tests in [`app/test/`](app/test/) |
| Platform services | `entry/src/main/ets/services` | [`app/src/services`](app/src/services) (Expo modules) |
| View models | ArkUI State Management V2 | [`app/src/viewmodel`](app/src/viewmodel) (valtio) |
| Screens | ArkUI pages | [`app/src/pages`](app/src/pages) + expo-router routes in [`app/src/app`](app/src/app) |
| Offline vector map | ArkUI Canvas | Skia ([`app/src/views/map`](app/src/views/map)) |
| Home-screen card | Form Kit card | WidgetKit extension ([`app/targets/widget`](app/targets/widget)) |
| Course server | `server/` | [`server/`](server/) (unchanged Express + TypeScript) |
| Data pipeline and voice scripts | `scripts/pack`, `scripts/voice`, `data/` | same paths |

## Platform capabilities used (iOS)

| Capability | API | Where |
| --- | --- | --- |
| Location during a walk (real GPS, precise/approximate, services off, errors) | Core Location via `expo-location` `watchPositionAsync` | [`services/location`](app/src/services/location) |
| Walk keeps running with the screen off | `UIBackgroundModes` `location` + `audio`; `startLocationUpdatesAsync` on a TaskManager task (While Using permission, blue indicator) | [`services/background/BackgroundRunner.ts`](app/src/services/background/BackgroundRunner.ts) |
| Studio-voice stories (course clips, played by SHA-256 of the sentence) and runtime studio voice from the server | AVFoundation via `expo-audio` (playback session, background audio) | [`services/audio/ClipPlayer.ts`](app/src/services/audio/ClipPlayer.ts), [`services/speech`](app/src/services/speech) |
| Lock-screen Now Playing card (title, persona, play/pause) | `expo-audio` `setActiveForLockScreen` | [`services/media/MediaSessionService.ts`](app/src/services/media/MediaSessionService.ts) |
| Next-stop notification, updated in place | UserNotifications via `expo-notifications` | [`services/notify/TourNotifier.ts`](app/src/services/notify/TourNotifier.ts) |
| Arrival / approach / off-route haptics | Taptic Engine via `expo-haptics` | [`services/haptics/Haptics.ts`](app/src/services/haptics/Haptics.ts) |
| Home-screen "Next stop" widget | WidgetKit extension + App Group shared defaults (`@bacons/apple-targets`) | [`targets/widget`](app/targets/widget), [`viewmodel/WidgetBridge.ts`](app/src/viewmodel/WidgetBridge.ts) |
| Keep the screen on when background running is refused | `expo-keep-awake` | [`services/screen/KeepScreen.ts`](app/src/services/screen/KeepScreen.ts) |
| Signed course downloads | `fetch` with timeouts, Ed25519 (`@noble/ed25519`), SHA-256 (`expo-crypto`), atomic install (`expo-file-system`) | [`services/remote`](app/src/services/remote) |

## Mocked or simulated behavior

- **Demo walk (simulated location).** Offered for any course whose pack ships a demo track. It replays a recorded
  walk along the route through the same pipeline instead of GPS. Every walking surface shows the amber
  **SIMULATED** pill, the widget and notification say SIMULATED, and the logs say
  `LOC_SOURCE kind=demo simulated=true`. Start it with **Demo walk** on a Home card, or from the Developer page.
- **Tour summary time for the Demo walk** is a walking-pace time (walked metres at 1.3 m/s plus time at stops),
  labelled SIMULATED, as in the original.
- The iOS **simulator's GPS** can be moved (`xcrun simctl location booted set 50.0614,19.9366` puts you on the
  Rynek); that drives the *real* Core Location path, not the Demo walk.

## Differences from the HarmonyOS app

- **No system voice.** Each sentence plays its pre-rendered clip; without one the server renders it in the same
  studio voice (`POST /v1/tts`, 2.5 s budget, cached); without the server it is shown as text at reading pace.
  Settings rows that only managed the system voice (download the English voice, the English-voice strategy) are
  gone.
- **No watch app.**
- **Lock screen** offers play/pause only (expo-audio has no next/previous commands); audio interruptions and
  headphone removal reach the tour as a pause.
- **Precise vs approximate location** is inferred from fix accuracy (expo-location does not expose iOS accuracy
  authorization).
- **Developer page:** long-press Settings › About › Version, or open `citytour://DevPanel`. It adds a live view of
  the app log (the iOS stand-in for hilog).
- **Two fixes over the original:** the Developer page no longer takes the speech/background listeners from a
  running tour (the tour stalled after one sentence), and at a stop Now Walking names that stop even when a real-GPS
  tour starts mid-route.
- **Simulator GPS:** a fixed simulated location delivers one fix and then stays silent, so a real-GPS tour on the
  simulator reports `LOC_LOST` after ~26 s; use `xcrun simctl location booted start` with waypoints for a moving
  walk, or the Demo walk.
- **Expo SDK 54, not 57:** SDK 57 needs Xcode 26; the development machine runs Xcode 16.2.

## Requirements (tested versions)

| Tool | Version |
| --- | --- |
| macOS | 15.1, Apple Silicon |
| Xcode | 16.2 (iOS 18.3 simulator, iPhone 16 Pro); app minimum iOS 16.4 |
| CocoaPods | 1.17 |
| Node.js | 22 or later (developed with 24.x) |

## Build and run on the simulator

```bash
cd app && npm ci
```

```bash
scripts/ios-build.sh            # prebuild (ios/ is generated), xcodebuild, install on the booted simulator
```

```bash
cd app && npx expo start --dev-client
```

Then open CityTour on the simulator (or `xcrun simctl openurl booted "citytour://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081"`).
JavaScript changes reload live; rerun `scripts/ios-build.sh` only after a native change (a new Expo module, `app.json`,
the widget).

The app talks to the deployed course server `https://citytour-server.onrender.com` and verifies everything with the
public key in [`app/src/main/RemoteConfig.ts`](app/src/main/RemoteConfig.ts). No secret is in the app.

## Testing

```bash
cd core && npm ci && npm test        # 445 core tests (engine, planner, replay of the SIMULATED demo track, ...)
```

```bash
cd app && npm test && npm run typecheck && npx expo lint
```

```bash
cd server && npm ci && npm test      # 45 server tests (ElevenLabs always mocked)
```

```bash
node --test scripts/pack/*.test.mjs scripts/voice/*.test.mjs   # 187 pipeline tests
```

GitHub Actions runs all four on every push ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

## Logs

Every key event is one line `CityTour <level> EVENT k=v ...` (the same events as the HarmonyOS app: `APP_START`,
`PACK_LOAD`, `ROUTE_PLAN`, `LOC_SOURCE`, `LOC_FIX`, `POI_ENTER`, `STORY_START`, `UTT_START`, `UTT_DONE`,
`NARR_AUDIO src=prerendered|remote|text`, `OFF_ROUTE`, `REPLAN`, `WIDGET`, `NOTIF_PUBLISH`, `HAPTIC`, `BG_START`,
`STATE ... to=finished`, ...). They appear in the Metro terminal and on the Developer page.

## Course server

Express + TypeScript, unchanged from the original: [`server/README.md`](server/README.md). Run it locally, publish
courses and smoke-test without any ElevenLabs call as described there. To point the app at a local server, set
`BASE_URL` in `app/src/main/RemoteConfig.ts` (and the matching public key).

## Data sources and licences

Wikidata (CC0), Wikipedia en/pl/zh (CC BY-SA 4.0), OpenStreetMap (ODbL, "© OpenStreetMap contributors" on every
map), OSRM walking legs (ODbL), City of Kraków ArcGIS (unverified terms), Wikimedia Commons cover photos
(CC BY-SA 4.0), ElevenLabs studio-voice clips (AI-generated). Details: [`data/ATTRIBUTION.md`](data/ATTRIBUTION.md)
and [`data/raw/SOURCES.md`](data/raw/SOURCES.md). The Historian stories and the Polish and Chinese texts were drafted
by AI and not reviewed by a historian or native speakers.

## AI usage

See [`AI_WORKFLOW.md`](AI_WORKFLOW.md).
