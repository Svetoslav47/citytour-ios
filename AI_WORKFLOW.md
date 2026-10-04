# AI Workflow

This repository is an AI-assisted port of the HarmonyOS app [CityTour](https://github.com/Svetoslav47/citytour) to
iOS. Keep this document current and public-safe: no credentials, tokens, personal data, private endpoints or
confidential prompts.

## Tools used

| Model, agent or tool | Version or source | Role |
| --- | --- | --- |
| Claude Code (Claude Opus 5.5, `claude-opus-5-5`) | Anthropic, Claude Code desktop app | Lead agent: planning, porting core and platform layer, integration, builds, simulator validation, docs |
| Claude Code sub-agents (same model) | Claude Code `Agent` tool | Parallel porting of services, view models and screens on disjoint files, each validated with `tsc` |
| Expo CLI / `create-expo-app` | Expo SDK 54 (`expo` ~54.0) | Project scaffold, prebuild, config plugins |
| Xcode | 16.2, iOS 18.3 simulator (iPhone 16 Pro) | Native build and the simulator runs |
| vitest | 3.x (core), 5.x (server) | Unit tests |

## Work log

### 2026-10-04 — port kickoff

- **Prompt (summary):** create a new GitHub repo and port the whole app to iOS; the watch app and the built-in
  system TTS may be dropped, everything else must be ported; server Express + TypeScript, frontend latest Expo with
  React Native and TypeScript; use the emulator.
- **Decision by the user:** Expo SDK 57 (latest) needs Xcode 26, which this Mac (macOS 15.1, Xcode 16.2) cannot run;
  the user chose to downgrade to **Expo SDK 54** and to make the repository **public**.
- **Generated:** `core/` is the HarmonyOS `common` HAR (contracts, core logic, `TourController`) copied as TypeScript;
  only ArkUI decorators and timer typings needed changes. The 445 hypium tests were converted to vitest with a script
  (assert mapping, `done` callbacks to promises) and all pass. `server/`, `data/`, `scripts/pack`, `scripts/voice`
  were copied; test paths that pointed at ArkTS files were updated (server 45/45, pipeline 187/187).
- **Platform layer:** strings (en/pl/zh JSON from the resource files), colour tokens, logging (console + ring
  buffer instead of hilog), persistence (AsyncStorage instead of PersistenceV2), navigation (expo-router instead of
  NavPathStack), WidgetKit extension for the home-screen card. Conventions in [`docs/PORTING.md`](docs/PORTING.md).
- **Review/validation:** see the following entries; nothing is claimed as verified until it ran on the simulator.

### 2026-10-04 — app layer ported by parallel agents, first simulator runs

- **Work split:** seven sub-agents ported disjoint file sets against `docs/PORTING.md` (remote + pack services;
  speech/audio/lock screen/background; location/notifications/haptics; view models; Home/Courses/Tour screens;
  Now Walking/Summary/Place screens; Onboarding/Settings/Developer screens; Skia map). Each validated its files with
  `tsc`; the lead wired `AppContainer`, the root layout, the WidgetKit extension and the build script.
- **Product decision applied:** no system TTS on iOS. The agent adapted `VoiceManager` so a platform text-only plan
  becomes a voice plan whenever the server's studio voice can be asked, so every sentence goes clip → server →
  text. Verified on the simulator: 32 sentences from course clips (`src=prerendered reason=hash_match`), 2 rendered by
  the server (`src=remote reason=server_ok`).
- **Failures found on the simulator and fixed:** expo-audio pulled an SDK 57 `expo-asset` (app did not start);
  expo-router treated `src/app/*.ts` helpers as routes; onboarding claimed "text only" for every language; the
  background start asked for "Always" location mid-start and timed out (expo-location needs only While Using);
  `console.error` raised LogBox toasts over the UI.
- **Verified by the agent on the iPhone 16 Pro simulator (iOS 18.3):** onboarding (3 steps, both permission dialogs),
  Home from the signed catalog with covers, Royal Route Demo walk: stream, Held-Karp plan, background start, stop
  entry, notification, haptic call, widget push, lock-screen session, turn-by-turn cues, demo controls (speed ×8).
- **Not verifiable on the simulator:** haptics (no Taptic Engine), real background behaviour with the screen locked
  over a long walk, the widget as placed on a home screen (needs manual placement).
