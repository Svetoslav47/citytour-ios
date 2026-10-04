# Porting guide: HarmonyOS (ArkTS/ArkUI) → iOS (Expo SDK 54, React Native, TypeScript)

The original app lives at https://github.com/Svetoslav47/citytour (local checkout `../citytour`). This repo ports it
to iOS. The Apple Watch app (`wearable/`) and the built-in system TTS voice are **dropped by decision**; everything
else is ported.

## Layout

| Original | Port |
| --- | --- |
| `common/src/main/ets/**` (contracts, core, control) | `core/src/**` (`@citytour/core`), plain TS, unchanged logic |
| `entry/src/test/*.test.ets` (hypium) | `core/test/*.test.ts` (vitest) |
| `entry/src/main/ets/app/*` | `app/src/app/*` |
| `entry/src/main/ets/services/**` | `app/src/services/**` |
| `entry/src/main/ets/viewmodel/**` | `app/src/viewmodel/**` |
| `entry/src/main/ets/views/**` (ArkUI components) | `app/src/views/**` (`.tsx` React Native components) |
| `entry/src/main/ets/pages/*Page.ets` | `app/src/pages/*Page.tsx` (screen bodies) + `app/src/app/<Route>.tsx` (expo-router route files) |
| `entry/src/main/resources/*/element/string.json` | `app/src/i18n/{en,pl,zh}.json`, read with `t()` from `@/platform/strings` |
| `common/src/main/resources/*/element/color.json` | `app/src/theme/colors.json`, read with `useColors()` from `@/theme` |
| `views/common/Tokens.ets` | `@/theme` (`Space`, `Radius`, `Type`, `Size`, `TABULAR`) |
| `server/` | `server/` (unchanged Express + TypeScript) |

Imports: `from 'common'` → `from '@citytour/core'`; app-internal imports use `@/…` (maps to `app/src/…`) or
relative paths.

## State: `@ObservedV2` / `@Trace` → valtio

- Remove `@ObservedV2`, `@Trace`, `@Local`, `@Param`, `@Event`, `@Monitor`, `@Computed` decorators.
- A view-model instance that the UI observes is wrapped with valtio `proxy()` where it is created
  (`static get()` singletons: `AppViewModel.inst = proxy(new AppViewModel())`; per-screen VMs:
  `const vm = useMemo(() => proxy(new HomeViewModel()), [])`).
- Components read state through `const s = useSnapshot(vm)` and call methods on the **proxy** (`vm.start()`),
  never on the snapshot.
- Any field that holds a service, controller, platform object, function or large immutable data (packs, map data)
  must be wrapped with valtio `ref(...)` so valtio does not deep-proxy it.
- `PersistenceV2.connect(Class, key, factory)` → `connect(key, factory)` from `@/platform/Persist` (already a proxy,
  saved to AsyncStorage on change; hydrated at app start).
- `AppStorageV2.connect(...)` (non-persistent shared state) → a module-level `proxy(...)` singleton.

## Navigation

`AppViewModel.stack` is `NavPathStack` from `@/platform/Nav` (same `pushPath(new NavPathInfo(name, param))`,
`pop()`, `clear()` API). Every `Routes.X` name is an expo-router file `app/src/app/<Name>.tsx` that reads its one
parameter with `useLocalSearchParams<{ p?: string }>().p`.

## Strings

`$r('app.string.key')` → `t('key')`; `getStringSync($r('app.string.key'), a, b)` / `getStringByNameSync('key', a)`
→ `t('key', a, b)`. In components call `const t = useT()` so a language switch re-renders.
`i18n.System.setAppPreferredLanguage(x)` → `setAppLanguage('' | 'en' | 'pl' | 'zh')`.

## Platform APIs (`@kit.*`)

| HarmonyOS | iOS / Expo |
| --- | --- |
| hilog (`app/Log.ets`) | `@/app/Log` (console + in-memory ring buffer shown on the Developer page) |
| Location Kit `geoLocationManager` | `expo-location` (`watchPositionAsync`; background updates with `expo-task-manager`) |
| `abilityAccessCtrl` location permission | `expo-location` `requestForegroundPermissionsAsync` / `getForegroundPermissionsAsync`; precise vs approximate from `ios.accuracy` |
| `requestGlobalSwitch` (location switch) | `Location.hasServicesEnabledAsync()`; when off, `Linking.openSettings()` |
| Media Kit `AVPlayer` (clips) | `expo-audio` `createAudioPlayer` |
| AVSession Kit (lock screen) | `expo-audio` `player.setActiveForLockScreen(true, metadata)` / `updateLockScreenMetadata` |
| Background Tasks Kit continuous task | `UIBackgroundModes` `location` + `audio`; background location updates via `Location.startLocationUpdatesAsync` |
| Notification Kit | `expo-notifications` (same id → replaced in place) |
| Sensor Service Kit `vibrator` | `expo-haptics` |
| `window.setWindowKeepScreenOn` | `expo-keep-awake` |
| Network Kit `http` | `fetch` + `AbortController` (explicit timeouts on every call) |
| Core File Kit `fileIo` | `expo-file-system` (`File`, `Directory`, `Paths.document`) |
| Crypto Architecture Kit SHA-256 | `expo-crypto` `digest` (blobs) / core `sha256Hex` (sentences) |
| Crypto Architecture Kit Ed25519 verify | `@noble/ed25519` (`verifyAsync`, raw key = last 32 bytes of the SPKI DER) |
| TaskPool | plain async (Hermes has no worker threads); yield with `await new Promise(r => setTimeout(r, 0))` for long loops |
| Form Kit card (widget) | WidgetKit extension in `app/targets/widget` (`@bacons/apple-targets`), data via App Group `group.com.hackyeah.citytour.ios` |
| ArkUI `Canvas` (map) | `@shopify/react-native-skia` |
| Core Speech Kit (system TTS) | **dropped**: no system voice; clips → server studio voice → on-screen text |
| Wear Engine / watch HAP | **dropped** |

## ArkUI → React Native

- `Column` → `View` (flexDirection column), `Row` → `View` with `flexDirection: 'row'`, `Stack` → `View` with
  absolutely positioned children, `Scroll`/`List` → `ScrollView`/`FlatList`, `Text` → `Text`, `Button` →
  `Pressable`, `Image` → `expo-image` `Image`, `Toggle` → `Switch`, `Progress` → custom view, `bindSheet` → `Modal`
  (pageSheet) or an absolutely positioned sheet.
- Sizes in `vp`/`fp` are React Native points 1:1.
- `.id('btnX')` → `testID="btnX"` (the smoke run and the developer page rely on these ids).
- Keep the visual design of the original screens (see `../citytour/docs/img/*.png` and `docs/DESIGN.md` there):
  same layout, copy, colours, spacing and states. Do not invent new UI.
