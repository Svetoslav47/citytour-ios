/*
 * Parses a downloaded course's clip manifest (audio/manifest.json, ~0.5 MB for a full course) and turns its
 * course-relative clip paths into absolute file URIs under `root`.
 * HarmonyOS ran this on a TaskPool worker. Hermes has no worker threads, so on iOS it is a plain async function: it
 * yields once to the event loop before the parse (so the caller's frame finishes first) and keeps the same exported
 * name, contract and fallback log line.
 */
import { ClipEntry, parseClipManifest } from '@citytour/core';
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';

function parseCourseClips(text: string, root: string): ClipEntry[] {
  const m = parseClipManifest(text);
  const out: ClipEntry[] = [];
  for (const e of m.entries) {
    const c: ClipEntry = {
      lang: e.lang, poiId: e.poiId, personaId: e.personaId, length: e.length, n: e.n, file: `${root}/${e.file}`,
      textSha256: e.textSha256, durationMs: e.durationMs
    };
    out.push(c);
  }
  return out;
}

/** Clip entries with absolute file paths under `root`; [] when the text is not a valid manifest. Never rejects. */
export async function courseClipsOffThread(text: string, root: string): Promise<ClipEntry[]> {
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return parseCourseClips(text, root);
  } catch (e) {
    Log.w(LogEvents.NARR_AUDIO, `event=course_clips_taskpool_fail ${Log.errKv(e as Object)} fallback=ui_thread`);
    return [];
  }
}
