/*
 * PcmPlayer (HarmonyOS AudioRenderer for Core Speech Kit PCM, ARCHITECTURE §2.5) is NOT PORTED: the built-in system
 * TTS is dropped in the iOS port (docs/PORTING.md), so there is no PCM to render. Every sentence with audio is a clip
 * or a server studio line played by ClipPlayer (expo-audio); NarrationPlayer no longer references this file.
 * Kept as an empty module only so the file layout mirrors the original app.
 */
export {};
