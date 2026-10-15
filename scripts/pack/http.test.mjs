// Tests for scripts/pack/lib/http.mjs: retry/backoff, rate limit, UA, timeout, snapshot encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  USER_AGENT,
  RateLimiter,
  backoffDelayMs,
  createHttp,
  encodeSnapshot,
  isRetryableStatus,
  minIntervalFor,
  parseArgs,
  stableStringify,
} from './lib/http.mjs';

function fakeClock() {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function res(status, body = '{}', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

test('parseArgs accepts --offline / --refresh and rejects typos', () => {
  const none = { course: null, tour: null };
  assert.deepEqual(parseArgs([]), { offline: false, refresh: false, ...none });
  assert.deepEqual(parseArgs(['--offline']), { offline: true, refresh: false, ...none });
  assert.deepEqual(parseArgs(['--refresh']), { offline: false, refresh: true, ...none });
  assert.deepEqual(parseArgs(['--offline', '--course', 'krakow-scholars']), { offline: true, refresh: false, course: 'krakow-scholars', tour: null });
  assert.deepEqual(parseArgs(['--tour', 'scholars-saints']), { offline: false, refresh: false, course: null, tour: 'scholars-saints' });
  assert.throws(() => parseArgs(['--course']), /needs a value/);
  assert.throws(() => parseArgs(['--ofline']), /unknown argument/);
  assert.throws(() => parseArgs(['--offline', '--refresh']), /mutually exclusive/);
});

test('retryable statuses: 429, 408 and 5xx only', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404, 406]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('backoff doubles, honours Retry-After and is capped at 60 s', () => {
  assert.equal(backoffDelayMs(0, 1000), 1000);
  assert.equal(backoffDelayMs(1, 1000), 2000);
  assert.equal(backoffDelayMs(2, 1000), 4000);
  assert.equal(backoffDelayMs(0, 1000, '5'), 5000);
  assert.equal(backoffDelayMs(0, 1000, 'garbage'), 1000);
  assert.equal(backoffDelayMs(10, 1000), 60_000);
});

test('per-host intervals: OSRM and OSM 1 req/s, Wikipedia 5 req/s', () => {
  assert.equal(minIntervalFor('routing.openstreetmap.de'), 1000);
  assert.equal(minIntervalFor('api.openstreetmap.org'), 1000);
  assert.equal(minIntervalFor('en.wikipedia.org'), 200);
  assert.equal(minIntervalFor('www.wikidata.org'), 200);
  assert.equal(minIntervalFor('query.wikidata.org'), 1000);
});

test('rate limiter spaces requests to one host and leaves other hosts alone', async () => {
  const c = fakeClock();
  const rl = new RateLimiter({ now: c.now, sleep: c.sleep, intervalFor: () => 1000 });
  await rl.wait('a');
  await rl.wait('a');
  await rl.wait('b');
  await rl.wait('a');
  assert.deepEqual(c.sleeps, [1000, 1000]);
});

test('client sends the User-Agent and retries 503 then succeeds', async () => {
  const c = fakeClock();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.headers['User-Agent']);
    return calls.length < 3 ? res(503, 'busy') : res(200, '{"ok":true}');
  };
  const http = createHttp({ fetchImpl, sleep: c.sleep, now: c.now, log: () => {} });
  assert.deepEqual(await http.getJson('https://example.org/x'), { ok: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((ua) => ua === USER_AGENT));
  // backoff 1 s then 2 s (the rate-limit waits are 500 ms default for example.org, absorbed by backoff)
  assert.ok(c.sleeps.includes(1000) && c.sleeps.includes(2000), JSON.stringify(c.sleeps));
});

test('client gives up after 3 retries (4 attempts) on persistent 5xx', async () => {
  const c = fakeClock();
  let n = 0;
  const http = createHttp({ fetchImpl: async () => (n++, res(504, 'gateway')), sleep: c.sleep, now: c.now, log: () => {} });
  await assert.rejects(http.getJson('https://example.org/x'), /HTTP 504/);
  assert.equal(n, 4);
});

test('client fails fast on 404 (no retry)', async () => {
  const c = fakeClock();
  let n = 0;
  const http = createHttp({ fetchImpl: async () => (n++, res(404, 'nope')), sleep: c.sleep, now: c.now, log: () => {} });
  await assert.rejects(http.getJson('https://example.org/x'), /HTTP 404/);
  assert.equal(n, 1);
});

test('client retries network errors and timeouts', async () => {
  const c = fakeClock();
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) {
      // Hang until the client's AbortController fires.
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return res(200, '[1]');
  };
  const http = createHttp({ fetchImpl, sleep: c.sleep, now: c.now, timeoutMs: 20, log: () => {} });
  assert.deepEqual(await http.getJson('https://example.org/x'), [1]);
  assert.equal(n, 3);
});

test('stableStringify sorts keys recursively and keeps array order', () => {
  const a = stableStringify({ b: 1, a: { d: [3, 1], c: null } });
  const b = stableStringify({ a: { c: null, d: [3, 1] }, b: 1 });
  assert.equal(a, b);
  assert.ok(a.indexOf('"a"') < a.indexOf('"b"'));
  assert.ok(a.endsWith('\n'));
});

test('encodeSnapshot gzips only above the threshold, deterministically', () => {
  const small = encodeSnapshot({ x: 1 }, 100);
  assert.equal(small.gzipped, false);
  const bigObj = { s: 'x'.repeat(500) };
  const big1 = encodeSnapshot(bigObj, 100);
  const big2 = encodeSnapshot(bigObj, 100);
  assert.equal(big1.gzipped, true);
  assert.deepEqual(big1.bytes, big2.bytes);
  assert.equal(JSON.parse(gunzipSync(big1.bytes).toString()).s.length, 500);
});
