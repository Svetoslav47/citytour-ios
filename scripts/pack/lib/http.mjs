// CityTour pack pipeline: shared HTTP + snapshot helpers (Node 22+ ESM, stdlib only).
//
// Every network call made by the fetch scripts goes through createHttp(): it sends the project
// User-Agent, aborts after a timeout, retries transient failures with exponential backoff and
// waits for a per-host rate limit. Snapshots are written under data/raw/ as pretty JSON with a
// stable (sorted) key order, gzipped when larger than 1 MB, and are never re-fetched unless the
// script is run with --refresh. With --offline no request is ever sent: a missing snapshot is an
// error (exit code 1), so `node <script> --offline` proves the committed data is complete.

import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const USER_AGENT = 'CityTour-HackYeah2026 (+https://github.com/Svetoslav47/citytour)';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 3;
export const GZIP_THRESHOLD_BYTES = 1024 * 1024;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RAW_DIR = join(REPO_ROOT, 'data', 'raw');
/** The default course's tour (scripts/pack/lib/course.mjs resolves the others). */
export const TOUR_FILE = join(REPO_ROOT, 'data', 'tours', 'royal-route.json');

/** Minimum spacing between two requests to the same host, in ms (first match wins). */
export const HOST_INTERVALS_MS = [
  [/^routing\.openstreetmap\.de$/, 1000], // OSRM demo server: 1 req/s
  [/(^|\.)openstreetmap\.org$/, 1000], // OSM main API: 1 req/s
  [/^query\.wikidata\.org$/, 1000], // SPARQL: few, heavy queries
  [/(^|\.)wikidata\.org$/, 200], // ~5 req/s
  [/(^|\.)wikipedia\.org$/, 200], // ~5 req/s
  [/(^|\.)arcgis\.com$/, 250],
];
export const DEFAULT_INTERVAL_MS = 500;

export function minIntervalFor(host) {
  for (const [re, ms] of HOST_INTERVALS_MS) if (re.test(host)) return ms;
  return DEFAULT_INTERVAL_MS;
}

/** CLI flags shared by every fetch script. Unknown flags are an error (typos must not fetch). */
export function parseArgs(argv) {
  const out = { offline: false, refresh: false, course: null, tour: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--refresh') out.refresh = true;
    else if (a === '--course' || a === '--tour') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      out[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a} (expected --offline, --refresh, --course <id> or --tour <id>)`);
  }
  if (out.offline && out.refresh) throw new Error('--offline and --refresh are mutually exclusive');
  return out;
}

/** 408, 425, 429 and 5xx are transient; everything else (4xx) is a caller bug and fails fast. */
export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Backoff before retry number `attempt` (0-based): base * 2^attempt, at least the server's
 * Retry-After (seconds) when given, capped at 60 s.
 */
export function backoffDelayMs(attempt, baseMs = 1000, retryAfter = null) {
  let ms = baseMs * 2 ** attempt;
  const ra = retryAfter == null ? NaN : Number(retryAfter);
  if (Number.isFinite(ra) && ra >= 0) ms = Math.max(ms, ra * 1000);
  return Math.min(ms, 60_000);
}

export class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Per-host rate limiter. Slots are reserved synchronously, so concurrent callers on the same host
 * are serialised at the configured interval.
 */
export class RateLimiter {
  constructor({ now = () => Date.now(), sleep = defaultSleep, intervalFor = minIntervalFor } = {}) {
    this.now = now;
    this.sleep = sleep;
    this.intervalFor = intervalFor;
    this.next = new Map();
  }

  async wait(host) {
    const now = this.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + this.intervalFor(host));
    if (at > now) await this.sleep(at - now);
  }
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * HTTP client with UA, timeout, retries + backoff and per-host rate limiting.
 * `fetchImpl`, `sleep` and `now` are injectable for tests.
 */
export function createHttp({
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
  backoffBaseMs = 1000,
  log = (msg) => console.error(msg),
} = {}) {
  const limiter = new RateLimiter({ now, sleep });
  let requestCount = 0;

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    const host = new URL(url).host;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await limiter.wait(host);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
      let retryAfter = null;
      try {
        requestCount++;
        const res = await fetchImpl(url, {
          method,
          body,
          headers: { 'User-Agent': USER_AGENT, ...headers },
          signal: ctrl.signal,
        });
        // The body read is inside the timeout too.
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.ok) return { status: res.status, headers: res.headers, body: buf };
        retryAfter = res.headers?.get?.('retry-after') ?? null;
        lastErr = new HttpError(`HTTP ${res.status} for ${method} ${url}: ${buf.toString('utf8', 0, 200)}`, res.status);
        if (!isRetryableStatus(res.status)) throw lastErr;
      } catch (e) {
        if (e instanceof HttpError && e.status > 0 && !isRetryableStatus(e.status)) throw e;
        lastErr = e instanceof HttpError ? e : new HttpError(`${method} ${url}: ${e?.message ?? e}`);
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) {
        const wait = backoffDelayMs(attempt, backoffBaseMs, retryAfter);
        log(`  retry ${attempt + 1}/${retries} in ${wait} ms (${lastErr.message.slice(0, 160)})`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  return {
    request,
    get requestCount() {
      return requestCount;
    },
    async getJson(url, headers = {}) {
      const r = await request(url, { headers: { Accept: 'application/json', ...headers } });
      return JSON.parse(r.body.toString('utf8'));
    },
    async postFormJson(url, form, headers = {}) {
      const r = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
        body: new URLSearchParams(form).toString(),
      });
      return JSON.parse(r.body.toString('utf8'));
    },
    async getBuffer(url, headers = {}) {
      return (await request(url, { headers })).body;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshots on disk

/** JSON with keys sorted recursively (arrays keep their order), 1-space indent, trailing newline. */
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 1) + '\n';
}

export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** Encodes a snapshot: plain JSON up to 1 MB, otherwise gzip (deterministic header: mtime 0). */
export function encodeSnapshot(obj, threshold = GZIP_THRESHOLD_BYTES) {
  const text = Buffer.from(stableStringify(obj), 'utf8');
  if (text.length > threshold) return { gzipped: true, bytes: gzipSync(text, { level: 9 }), rawBytes: text.length };
  return { gzipped: false, bytes: text, rawBytes: text.length };
}

export function rawPath(rel) {
  return join(RAW_DIR, rel);
}

/** Path of an existing snapshot (`rel` or `rel.gz`), or null. */
export function findSnapshot(rel) {
  const p = rawPath(rel);
  if (existsSync(p)) return p;
  if (existsSync(p + '.gz')) return p + '.gz';
  return null;
}

export function readSnapshot(rel) {
  const p = findSnapshot(rel);
  if (!p) throw new MissingSnapshotError(rel);
  const buf = readFileSync(p);
  return JSON.parse((p.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'));
}

/** Writes `rel` (or `rel.gz` when > 1 MB) and removes the other variant so only one exists. */
export function writeSnapshot(rel, obj) {
  const p = rawPath(rel);
  mkdirSync(dirname(p), { recursive: true });
  const enc = encodeSnapshot(obj);
  const target = enc.gzipped ? p + '.gz' : p;
  const other = enc.gzipped ? p : p + '.gz';
  writeFileSync(target, enc.bytes);
  if (existsSync(other)) rmSync(other);
  return { path: target, bytes: enc.bytes.length, rawBytes: enc.rawBytes, gzipped: enc.gzipped };
}

export class MissingSnapshotError extends Error {
  constructor(rel) {
    super(`offline: snapshot data/raw/${rel} is missing (run without --offline to fetch it)`);
    this.name = 'MissingSnapshotError';
  }
}

/**
 * Idempotent snapshot: returns the committed snapshot when it exists (unless --refresh),
 * fails with MissingSnapshotError when --offline, otherwise runs `fetchFn` and writes the result.
 */
export async function ensureSnapshot(rel, args, fetchFn) {
  if (!args.refresh && findSnapshot(rel)) {
    console.error(`  keep   data/raw/${rel}${findSnapshot(rel).endsWith('.gz') ? '.gz' : ''} (exists)`);
    return readSnapshot(rel);
  }
  if (args.offline) throw new MissingSnapshotError(rel);
  const obj = await fetchFn();
  const w = writeSnapshot(rel, obj);
  console.error(`  wrote  ${relative(REPO_ROOT, w.path)} (${fmtBytes(w.bytes)}${w.gzipped ? `, gzip of ${fmtBytes(w.rawBytes)}` : ''})`);
  return obj;
}

export function fileSize(p) {
  return statSync(p).size;
}

export function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** UTC ISO timestamp without milliseconds. */
export function nowIso(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The curated tour JSON (default data/tours/royal-route.json; a course's tour: readTour(course.tourFile)). */
export function readTour(file = TOUR_FILE) {
  if (!existsSync(file)) throw new Error(`missing ${relative(REPO_ROOT, file)}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** True when the module at `metaUrl` is the script node was started with (not an import from a test). */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}

/**
 * Runs a script's async main and maps any error to exit code 1 with a one-line reason.
 * Sets process.exitCode and lets Node exit on its own: calling process.exit() right after parsing
 * tens of MB of JSON/XML deadlocked Node 26 at shutdown (main thread joining a V8 worker that waited
 * for a GC), seen once with 20-fetch-osm-tiles.mjs --offline on 2026-10-03.
 */
export function runMain(main) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`FAILED: ${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  main(args).then(
    () => {
      process.exitCode = 0;
    },
    (e) => {
      console.error(`FAILED: ${e?.message ?? e}`);
      process.exitCode = 1;
    },
  );
}
