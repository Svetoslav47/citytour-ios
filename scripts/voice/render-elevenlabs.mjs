#!/usr/bin/env node
// Pre-renders the Historian stop stories with ElevenLabs, one mp3 clip per sentence (task A13, docs/PLAN.md), and
// (phase 3) every finite non-story line the engine speaks: welcome/finish/GPS lost/off-route/replan, arrival lines
// and the A9 turn-by-turn cues of the pack legs (scripts/voice/system-lines.mjs), so the guide speaks in one voice.
//
// Why build time: no API key in the app, no network at runtime, deterministic demo. The app plays a clip only when
// audio/manifest.json of the downloaded course has an entry whose textSha256 equals SHA-256(UTF-8 of the exact sentence the app
// speaks) for the same language and persona (core/speech/ClipSelection.ets); otherwise it uses native TTS.
//
// Input : Narration[] per language (contracts/Model.ets), default
//         data/course/krakow/packs/krakow/narrations/<lang>.json (B7 output).
//         --fixture uses scripts/voice/fixtures/narrations (the developer stub pack sentences).
// Output: data/course/krakow/audio/<lang>/<poiId>/<length>_<n>.mp3 and audio/manifest.json.
//         (<length>_ prefix: teaser/full/deep of one stop each have their own sentence 0.)
//         System lines: audio/<lang>/_<group>/<sha256 prefix>.mp3, manifest length=<group> (system|arrival|nav),
//         poiId '' (the app matches on the text hash only; ClipIndex.hasLang ignores them for the story label).
//
// Secrets: ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID come from the environment only. The key is sent in the
// xi-api-key request header and is never printed, logged or written anywhere.
//
// Usage:
//   node scripts/voice/render-elevenlabs.mjs --dry-run                 # counts only, no key needed
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node scripts/voice/render-elevenlabs.mjs --limit 3
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... node scripts/voice/render-elevenlabs.mjs
// Options: --narrations-dir <dir> --out <courseDir> --langs en,pl,zh --lengths teaser,full,deep
//          --persona historian --tour <tour.json> | --all-pois --model <id> --output-format <fmt>
//          --limit <n> --concurrency <n> --force --no-context --no-prune --fixture
//          System lines (on by default, off with --fixture): --no-system | --system-only
//          --system-groups system,arrival,nav --nav-legs all|tour --pack <packDir> --tour-id royal-route
//          --course <courseId>: one course of scripts/pack/lib/course.mjs (default krakow). Sets the defaults of
//          --narrations-dir (data/course/<id>/packs/<id>/narrations), --out (data/course/<id>), --tour
//          (data/tours/<tourId>.json), --pack and --tour-id; an explicit flag still wins. Each course has its own
//          audio/manifest.json, e.g. --course krakow-scholars writes data/course/krakow-scholars/audio/.
// Only clips in the selected scope (languages x stories/system groups) are re-planned or pruned; manifest entries
// outside it are kept as they are.
// Node 22+, stdlib only (fetch, crypto, fs).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_PACK_DIR, DEFAULT_TOUR_ID, GROUPS as SYSTEM_GROUPS, enumerateCases, linesFromCases, loadPack
} from './system-lines.mjs';
import { resolveCourse } from '../pack/lib/course.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const DEFAULT_NARRATIONS_DIR = join(ROOT, 'data/course/krakow/packs/krakow/narrations');
export const FIXTURE_NARRATIONS_DIR = join(HERE, 'fixtures/narrations');
export const DEFAULT_OUT = join(ROOT, 'data/course/krakow');
export const DEFAULT_TOUR = join(ROOT, 'data/tours/royal-route.json');
export const AUDIO_SUBDIR = 'audio';
export const MANIFEST_NAME = 'manifest.json';
export const DEFAULT_MODEL = 'eleven_multilingual_v2';
// Mono mp3 (ElevenLabs output is mono). 44.1 kHz / 64 kbps = 8 KB per second of speech.
// mp3_22050_32 halves the size if the 45 MB budget is at risk.
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_64';
export const API_BASE = 'https://api.elevenlabs.io';
export const REQUEST_TIMEOUT_MS = 90000;
export const MAX_ATTEMPTS = 4;
export const LENGTHS = ['teaser', 'full', 'deep'];
export const LANGS = ['en', 'pl', 'zh'];
export const SIZE_BUDGET_MB = 45;
// Rough speaking rates for the estimate only (characters of stripped text per second of audio).
const CHARS_PER_SECOND = { en: 15, pl: 14, zh: 4.5 };

// ---------------------------------------------------------------- pure helpers (unit-tested)

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`, exactly as the app hashes Utterance.text at runtime. */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Same as core/speech/VoicePolicy.stripPauseMarkup: captions and character counts never include [pNNN]. */
export function stripPauseMarkup(text) {
  return text.replace(/\[p\d+\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * The text sent to ElevenLabs: Core Speech Kit pauses [pNNN] become <break time="N.Ns" /> (supported by
 * eleven_multilingual_v2), any other [x123] kit markup is dropped, whitespace collapsed.
 */
export function toElevenLabsText(text) {
  return text
    .replace(/\[p(\d+)\]/g, (_m, ms) => ` <break time="${(Math.min(3000, Number(ms)) / 1000).toFixed(1)}s" /> `)
    .replace(/\[[a-z]\d+\]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Output format "mp3_44100_64" -> { codec: 'mp3', sampleRate: 44100, kbps: 64 }. */
export function parseOutputFormat(fmt) {
  const m = /^mp3_(\d+)_(\d+)$/.exec(fmt || '');
  if (!m) {
    throw new Error(`unsupported --output-format ${fmt} (use an mp3_<rate>_<kbps> format, e.g. ${DEFAULT_OUTPUT_FORMAT})`);
  }
  return { codec: 'mp3', sampleRate: Number(m[1]), kbps: Number(m[2]) };
}

/** Clip path relative to the course root (the downloaded course keeps the same layout). */
export function clipRelPath(lang, poiId, length, n) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${AUDIO_SUBDIR}/${safe(lang)}/${safe(poiId)}/${safe(length)}_${n}.mp3`;
}

/** True for a manifest length that is a system-line group (system | arrival | nav), not a story length. */
export function isSystemGroup(length) {
  return SYSTEM_GROUPS.includes(length);
}

export function clipKey(c) {
  if (isSystemGroup(c.length)) {
    return `${c.lang}|${c.personaId}|${c.length}|${c.textSha256}`;   // system lines are keyed by their text
  }
  return `${c.lang}|${c.personaId}|${c.poiId}|${c.length}|${c.n}`;
}

/** Clip path of a system line: audio/<lang>/_<group>/<first 16 hex of the text hash>.mp3. */
export function systemClipRelPath(lang, group, sha) {
  const safe = (x) => String(x).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `${AUDIO_SUBDIR}/${safe(lang)}/_${safe(group)}/${sha.slice(0, 16)}.mp3`;
}

/** Render clips for the system-line render list (system-lines.mjs linesFromCases output). */
export function systemClips(lines, persona) {
  return lines.map((l) => ({
    lang: l.lang, poiId: '', personaId: persona, length: l.group, n: 0, text: l.text,
    ttsText: toElevenLabsText(l.text), previousText: '', nextText: '', textSha256: l.textSha256,
    chars: toElevenLabsText(l.text).length, file: systemClipRelPath(l.lang, l.group, l.textSha256)
  }));
}

/**
 * One clip per sentence of every matching narration.
 * opts: { langs: string[], lengths: string[], persona: string, poiIds: Set<string> | null }
 */
export function collectClips(narrationsByLang, opts) {
  const clips = [];
  for (const lang of opts.langs) {
    const list = narrationsByLang[lang] || [];
    for (const nar of list) {
      if (!nar || typeof nar !== 'object' || !Array.isArray(nar.sentences)) {
        continue;
      }
      if (nar.lang !== undefined && nar.lang !== lang) {
        continue;
      }
      if (opts.persona && nar.personaId !== opts.persona) {
        continue;
      }
      if (!opts.lengths.includes(nar.length)) {
        continue;
      }
      if (opts.poiIds && !opts.poiIds.has(nar.poiId)) {
        continue;
      }
      nar.sentences.forEach((s, n) => {
        if (typeof s !== 'string' || stripPauseMarkup(s).length === 0) {
          return;
        }
        clips.push({
          lang, poiId: nar.poiId, personaId: nar.personaId, length: nar.length, n,
          text: s,
          ttsText: toElevenLabsText(s),
          previousText: n > 0 ? toElevenLabsText(nar.sentences[n - 1]) : '',
          nextText: n + 1 < nar.sentences.length ? toElevenLabsText(nar.sentences[n + 1]) : '',
          textSha256: sha256Hex(s),
          chars: toElevenLabsText(s).length,
          file: clipRelPath(lang, nar.poiId, nar.length, n)
        });
      });
    }
  }
  return clips;
}

/** Per-language totals for --dry-run. ElevenLabs bills eleven_multilingual_v2 at 1 credit per character. */
export function summarize(clips, kbps) {
  const by = {};
  for (const c of clips) {
    const s = by[c.lang] || (by[c.lang] = { lang: c.lang, clips: 0, chars: 0, pois: new Set(), estSeconds: 0 });
    s.clips++;
    s.chars += c.chars;
    if (c.poiId) {
      s.pois.add(c.poiId);
    }
    s.estSeconds += stripPauseMarkup(c.text).length / (CHARS_PER_SECOND[c.lang] || 14);
  }
  const rows = Object.values(by).map((s) => ({
    lang: s.lang, pois: s.pois.size, clips: s.clips, chars: s.chars, credits: s.chars,
    estMinutes: s.estSeconds / 60, estMB: (s.estSeconds * kbps * 1000) / 8 / 1e6
  }));
  const total = rows.reduce((t, r) => ({
    clips: t.clips + r.clips, chars: t.chars + r.chars, credits: t.credits + r.credits,
    estMinutes: t.estMinutes + r.estMinutes, estMB: t.estMB + r.estMB
  }), { clips: 0, chars: 0, credits: 0, estMinutes: 0, estMB: 0 });
  const groups = {};
  for (const c of clips) {
    const kind = isSystemGroup(c.length) ? c.length : 'stories';
    const k = `${c.lang}|${kind}`;
    const g = groups[k] || (groups[k] = { lang: c.lang, kind, clips: 0, chars: 0 });
    g.clips++;
    g.chars += c.chars;
  }
  return { rows, total, groups: Object.values(groups) };
}

/**
 * Splits clips into reused (manifest entry with the same key, text hash, voice, model and format, file present)
 * and toRender. fileExists(relPath) is injected for tests.
 */
export function planRender(clips, manifest, cfg, fileExists, force = false, inScope = () => true) {
  const old = new Map();
  const outOfScope = [];
  for (const e of (manifest && Array.isArray(manifest.clips)) ? manifest.clips : []) {
    if (inScope(e)) {
      old.set(clipKey(e), e);
    } else {
      outOfScope.push(e);                 // another language / kind than this run: kept untouched
    }
  }
  const reuse = [];
  const toRender = [];
  for (const c of clips) {
    const e = old.get(clipKey(c));
    const same = e !== undefined && e.textSha256 === c.textSha256 && e.voiceId === cfg.voiceId &&
      e.model === cfg.model && e.outputFormat === cfg.outputFormat && e.file === c.file && fileExists(c.file);
    if (same && !force) {
      reuse.push(e);
    } else {
      toRender.push(c);
    }
  }
  const keep = new Set(clips.map((c) => c.file));
  const stale = [...old.values()].map((e) => e.file).filter((f) => typeof f === 'string' && !keep.has(f));
  return { reuse, toRender, stale, keep: outOfScope };
}

/** Manifest entry (no secrets: the voice id is a public identifier, the key is never stored). */
export function manifestEntry(c, cfg, bytes, renderedAt) {
  return {
    lang: c.lang, poiId: c.poiId, personaId: c.personaId, length: c.length, n: c.n, file: c.file,
    textSha256: c.textSha256, chars: c.chars, bytes,
    durationMs: Math.round((bytes * 8) / cfg.kbps),   // CBR mp3: bytes * 8 / kbps = ms
    voiceId: cfg.voiceId, model: cfg.model, outputFormat: cfg.outputFormat, renderedAt
  };
}

export function buildManifest(entries, cfg) {
  const sorted = [...entries].sort((a, b) => clipKey(a) < clipKey(b) ? -1 : clipKey(a) > clipKey(b) ? 1 : 0);
  return {
    schemaVersion: 1,
    generatedBy: 'scripts/voice/render-elevenlabs.mjs',
    provider: 'ElevenLabs',
    model: cfg.model,
    voiceId: cfg.voiceId,
    outputFormat: cfg.outputFormat,
    hash: 'sha256(utf8(sentence exactly as in Narration.sentences))',
    clips: sorted
  };
}

export function parseArgs(argv) {
  const o = {
    dryRun: false, narrationsDir: null, out: DEFAULT_OUT, langs: [...LANGS], lengths: [...LENGTHS],
    persona: 'historian', tour: DEFAULT_TOUR, allPois: false, model: DEFAULT_MODEL,
    outputFormat: DEFAULT_OUTPUT_FORMAT, limit: Infinity, concurrency: 2, force: false, context: true, prune: true,
    fixture: false, help: false, system: null, systemOnly: false, systemGroups: [...SYSTEM_GROUPS], navLegs: 'all',
    pack: DEFAULT_PACK_DIR, tourId: DEFAULT_TOUR_ID, course: null
  };
  const explicit = new Set();
  const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`${a} needs a value`);
      }
      return argv[++i];
    };
    explicit.add(a);
    switch (a) {
      case '--course': o.course = val(); break;
      case '--dry-run': o.dryRun = true; break;
      case '--narrations-dir': o.narrationsDir = resolve(val()); break;
      case '--out': o.out = resolve(val()); break;
      case '--langs': o.langs = list(val()); break;
      case '--lengths': o.lengths = list(val()); break;
      case '--persona': o.persona = val(); break;
      case '--tour': o.tour = resolve(val()); break;
      case '--all-pois': o.allPois = true; break;
      case '--model': o.model = val(); break;
      case '--output-format': o.outputFormat = val(); break;
      case '--limit': o.limit = Number(val()); break;
      case '--concurrency': o.concurrency = Math.max(1, Math.min(4, Number(val()) || 1)); break;
      case '--force': o.force = true; break;
      case '--no-context': o.context = false; break;
      case '--no-prune': o.prune = false; break;
      case '--fixture': o.fixture = true; break;
      case '--system': o.system = true; break;
      case '--no-system': o.system = false; break;
      case '--system-only': o.systemOnly = true; o.system = true; break;
      case '--system-groups': o.systemGroups = list(val()); break;
      case '--nav-legs': o.navLegs = val(); break;
      case '--pack': o.pack = resolve(val()); break;
      case '--tour-id': o.tourId = val(); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}`);
    }
  }
  if (o.course !== null) {
    const c = resolveCourse({ course: o.course });
    if (!explicit.has('--narrations-dir') && !o.fixture) o.narrationsDir = join(c.packDir, 'narrations');
    if (!explicit.has('--out')) o.out = c.courseDir;
    if (!explicit.has('--tour')) o.tour = c.tourFile;
    if (!explicit.has('--pack')) o.pack = c.packDir;
    if (!explicit.has('--tour-id')) o.tourId = c.tourId;
  }
  for (const l of o.lengths) {
    if (!LENGTHS.includes(l)) {
      throw new Error(`unknown length ${l} (use ${LENGTHS.join(',')})`);
    }
  }
  for (const g of o.systemGroups) {
    if (!SYSTEM_GROUPS.includes(g)) {
      throw new Error(`unknown system group ${g} (use ${SYSTEM_GROUPS.join(',')})`);
    }
  }
  if (o.navLegs !== 'all' && o.navLegs !== 'tour') {
    throw new Error('--nav-legs must be all or tour');
  }
  if (!Number.isFinite(o.limit) && o.limit !== Infinity) {
    throw new Error('--limit must be a number');
  }
  return o;
}

// ---------------------------------------------------------------- I/O

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadNarrations(dir, langs) {
  const by = {};
  for (const lang of langs) {
    const p = join(dir, `${lang}.json`);
    if (!existsSync(p)) {
      console.warn(`render-elevenlabs: no ${relative(ROOT, p)} (skipping ${lang})`);
      continue;
    }
    const data = readJson(p);
    by[lang] = Array.isArray(data) ? data : Array.isArray(data.narrations) ? data.narrations : [];
  }
  return by;
}

function tourPoiIds(path) {
  if (!existsSync(path)) {
    return null;
  }
  const t = readJson(path);
  const ids = (t.stops || []).map((s) => s.poiId).filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FatalError extends Error {}

/** One ElevenLabs text-to-speech call. Returns the mp3 bytes. Never includes the key in errors. */
async function ttsRequest(c, cfg, apiKey) {
  const url = `${API_BASE}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=${cfg.outputFormat}`;
  const body = {
    text: c.ttsText,
    model_id: cfg.model,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true }
  };
  if (cfg.context) {
    if (c.previousText) {
      body.previous_text = c.previousText;
    }
    if (c.nextText) {
      body.next_text = c.nextText;
    }
  }
  let lastErr = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      lastErr = `network: ${e && e.name === 'TimeoutError' ? `timeout ${REQUEST_TIMEOUT_MS} ms` : (e && e.message)}`;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 256) {
        lastErr = `suspiciously small audio (${buf.length} bytes)`;
        continue;
      }
      return buf;
    }
    const text = (await res.text().catch(() => '')).slice(0, 400);
    if (res.status === 401 || res.status === 403) {
      throw new FatalError(`HTTP ${res.status}: the API key was rejected (check ELEVENLABS_API_KEY; it is not shown). ${text}`);
    }
    if (res.status === 404) {
      throw new FatalError(`HTTP 404: voice not found (check ELEVENLABS_VOICE_ID). ${text}`);
    }
    if (res.status === 400 || res.status === 422) {
      if (/quota|credits/i.test(text)) {
        throw new FatalError(`HTTP ${res.status}: out of credits. ${text}`);
      }
      throw new Error(`HTTP ${res.status} ${text}`);
    }
    lastErr = `HTTP ${res.status} ${text}`;   // 429 / 5xx: retry with backoff
    await sleep(1500 * 2 ** attempt);
  }
  throw new Error(`gave up after ${MAX_ATTEMPTS} attempts: ${lastErr}`);
}

function printSummary(sum, cfg, title) {
  console.log(title);
  console.log('  lang  pois  clips   chars  credits  est.min  est.MB');
  for (const r of sum.rows) {
    console.log(`  ${r.lang.padEnd(4)} ${String(r.pois).padStart(5)} ${String(r.clips).padStart(6)} ` +
      `${String(r.chars).padStart(7)} ${String(r.credits).padStart(8)} ${r.estMinutes.toFixed(1).padStart(8)} ` +
      `${r.estMB.toFixed(2).padStart(7)}`);
  }
  const t = sum.total;
  console.log(`  all  ${''.padStart(5)} ${String(t.clips).padStart(6)} ${String(t.chars).padStart(7)} ` +
    `${String(t.credits).padStart(8)} ${t.estMinutes.toFixed(1).padStart(8)} ${t.estMB.toFixed(2).padStart(7)}`);
  if (sum.groups.some((g) => g.kind !== 'stories')) {
    console.log('  by kind:  lang  kind      clips   credits');
    for (const g of sum.groups) {
      console.log(`            ${g.lang.padEnd(4)}  ${g.kind.padEnd(8)} ${String(g.clips).padStart(6)} ${String(g.chars).padStart(9)}`);
    }
  }
  console.log(`  model=${cfg.model} format=${cfg.outputFormat} (1 credit per character for ${DEFAULT_MODEL};` +
    ` est.MB at ${cfg.kbps} kbps, budget ${SIZE_BUDGET_MB} MB)`);
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//'))
      .map((l) => l.slice(3)).join('\n'));
    return 0;
  }
  const fmt = parseOutputFormat(o.outputFormat);
  let dir = o.narrationsDir;
  let usingFixture = o.fixture;
  if (dir === null) {
    if (o.fixture) {
      dir = FIXTURE_NARRATIONS_DIR;
    } else if (existsSync(DEFAULT_NARRATIONS_DIR)) {
      dir = DEFAULT_NARRATIONS_DIR;
    } else if (o.dryRun) {
      console.warn(`render-elevenlabs: ${relative(ROOT, DEFAULT_NARRATIONS_DIR)} does not exist yet (B7 pack);` +
        ' dry run on the stub-pack fixture instead');
      dir = FIXTURE_NARRATIONS_DIR;
      usingFixture = true;
    } else {
      console.error(`render-elevenlabs: ${relative(ROOT, DEFAULT_NARRATIONS_DIR)} not found. Build the pack first, ` +
        'or pass --narrations-dir / --fixture.');
      return 2;
    }
  }
  // The stub fixture uses poi_stub_* ids, so the tour filter does not apply to it.
  const poiIds = (o.allPois || usingFixture) ? null : tourPoiIds(o.tour);
  const withStories = !o.systemOnly;
  const narr = withStories ? loadNarrations(dir, o.langs) : {};
  const clips = withStories ? collectClips(narr, { langs: o.langs, lengths: o.lengths, persona: o.persona, poiIds }) : [];
  // Phase 3: the fixed system lines, arrival lines and nav cues of the pack tour (default on, off for the fixture).
  const withSystem = o.system === null ? !usingFixture : o.system;
  let systemCount = 0;
  if (withSystem) {
    if (!existsSync(join(o.pack, 'tours.json'))) {
      console.warn(`render-elevenlabs: no pack at ${relative(ROOT, o.pack)}: system lines skipped`);
    } else {
      const pack = loadPack(o.pack, o.tourId);
      const lines = linesFromCases(enumerateCases(pack, { langs: o.langs, groups: o.systemGroups, navLegs: o.navLegs }));
      const sys = systemClips(lines, o.persona);
      systemCount = sys.length;
      clips.push(...sys);
    }
  }
  const inScope = (e) => o.langs.includes(e.lang) && (isSystemGroup(e.length) ?
    withSystem && o.systemGroups.includes(e.length) : withStories && o.lengths.includes(e.length));
  if (clips.length === 0) {
    console.error(`render-elevenlabs: no sentences matched (dir=${relative(ROOT, dir)} persona=${o.persona} ` +
      `lengths=${o.lengths.join(',')} tourFilter=${poiIds ? poiIds.size + ' pois' : 'off'})`);
    return 2;
  }
  const voiceIdEnv = process.env.ELEVENLABS_VOICE_ID || '';
  const cfg = {
    voiceId: voiceIdEnv, model: o.model, outputFormat: o.outputFormat, kbps: fmt.kbps, context: o.context
  };
  const audioDir = join(o.out, AUDIO_SUBDIR);
  const manifestPath = join(audioDir, MANIFEST_NAME);
  const oldManifest = existsSync(manifestPath) ? readJson(manifestPath) : null;
  const exists = (rel) => existsSync(join(o.out, rel));
  const sum = summarize(clips, fmt.kbps);
  console.log(`render-elevenlabs: input ${relative(ROOT, dir)}${usingFixture ? ' (FIXTURE, not the real pack)' : ''}` +
    ` langs=${o.langs.join(',')} lengths=${o.lengths.join(',')} persona=${o.persona}` +
    ` tourFilter=${poiIds ? `${poiIds.size} stops` : 'off'}` +
    ` system=${withSystem ? `${o.systemGroups.join(',')} navLegs=${o.navLegs} lines=${systemCount}` : 'off'}` +
    `${withStories ? '' : ' stories=off'}`);
  console.log(`render-elevenlabs: output ${relative(ROOT, manifestPath)} (pack ${relative(ROOT, o.pack)}, tour ${o.tourId})`);

  if (o.dryRun) {
    const dryCfg = { ...cfg, voiceId: voiceIdEnv || (oldManifest && oldManifest.voiceId) || '' };
    const p = planRender(clips, oldManifest, dryCfg, exists, o.force, inScope);
    printSummary(sum, cfg, 'DRY RUN (no API call):');
    const pendingChars = p.toRender.reduce((n, c) => n + c.chars, 0);
    const pendingBy = {};
    for (const c of p.toRender) {
      pendingBy[c.lang] = (pendingBy[c.lang] || 0) + c.chars;
    }
    console.log(`  existing manifest: ${oldManifest ? oldManifest.clips.length : 0} clips;` +
      ` would reuse ${p.reuse.length}, render ${p.toRender.length} (${pendingChars} credits), prune ${p.stale.length},` +
      ` keep ${p.keep.length} out of scope` +
      `${voiceIdEnv ? '' : ' (ELEVENLABS_VOICE_ID unset: reuse assumes the manifest voice)'}`);
    console.log(`  credits to spend per language: ${Object.entries(pendingBy).map(([l, n]) => `${l}=${n}`).join(' ') || 'none'}`);
    return 0;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY || '';
  if (!apiKey || !voiceIdEnv) {
    console.error('render-elevenlabs: set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in your shell environment ' +
      '(never in a file in this repo). Use --dry-run to count characters without a key.');
    return 2;
  }
  const plan = planRender(clips, oldManifest, cfg, exists, o.force, inScope);
  const todo = plan.toRender.slice(0, Number.isFinite(o.limit) ? Math.max(0, o.limit) : undefined);
  printSummary(sum, cfg, 'Render plan:');
  console.log(`  reuse ${plan.reuse.length}, render ${todo.length} of ${plan.toRender.length} pending` +
    ` (${todo.reduce((n, c) => n + c.chars, 0)} credits), stale ${plan.stale.length}`);

  const entries = new Map(plan.keep.concat(plan.reuse).map((e) => [clipKey(e), e]));
  // Clips not rendered in this run (--limit) keep their old entry only if it is still valid (planRender reused it).
  const save = () => writeFileAtomic(manifestPath, JSON.stringify(buildManifest([...entries.values()], cfg), null, 2) + '\n');
  let done = 0;
  let failed = 0;
  let fatal = null;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length > 0 && fatal === null) {
      const c = queue.shift();
      try {
        const buf = await ttsRequest(c, cfg, apiKey);
        writeFileAtomic(join(o.out, c.file), buf);
        entries.set(clipKey(c), manifestEntry(c, cfg, buf.length, new Date().toISOString()));
        save();
        done++;
        console.log(`  ok   ${c.file} chars=${c.chars} bytes=${buf.length} (${done}/${todo.length})`);
      } catch (e) {
        if (e instanceof FatalError) {
          fatal = e;
        } else {
          failed++;
          console.error(`  FAIL ${c.file}: ${e.message}`);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: o.concurrency }, worker));
  save();
  if (fatal !== null) {
    console.error(`render-elevenlabs: stopped: ${fatal.message}`);
  }
  if (o.prune && fatal === null && failed === 0 && todo.length === plan.toRender.length) {
    for (const f of plan.stale) {
      const p = join(o.out, f);
      if (f.startsWith(`${AUDIO_SUBDIR}/`) && existsSync(p)) {
        unlinkSync(p);
        console.log(`  pruned stale ${f}`);
      }
    }
  }
  let bytes = 0;
  for (const e of entries.values()) {
    const p = join(o.out, e.file);
    bytes += existsSync(p) ? statSync(p).size : 0;
  }
  console.log(`render-elevenlabs: rendered ${done}, failed ${failed}, manifest ${entries.size} clips, ` +
    `audio ${(bytes / 1e6).toFixed(2)} MB (budget ${SIZE_BUDGET_MB} MB) -> ${relative(ROOT, manifestPath)}`);
  return fatal !== null || failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(`render-elevenlabs: ${e && e.message ? e.message : e}`);
    process.exit(2);
  });
}
