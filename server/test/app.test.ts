import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyEnvelope } from '../src/canonical.js';
import { issueToken } from '../src/tokens.js';
import { UpstreamError } from '../src/tts/elevenlabs.js';
import {
  ALLOWED_TEXT, CACHED_MP3, CACHED_TEXT, FAKE_MP3, makeFixture, OTHER_ALLOWED, SECRET, sha
} from './helpers.js';

const auth = (): string => `Bearer ${issueToken(SECRET).token}`;
const tts = (text: string, extra: Record<string, unknown> = {}) => ({ courseId: 'krakow', lang: 'en', text, ...extra });

describe('public endpoints', () => {
  it('GET /healthz', async () => {
    const f = makeFixture();
    const r = await request(f.app).get('/healthz');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, version: 'test' });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');   // helmet
  });

  it('POST /v1/installs returns a 30-day token', async () => {
    const f = makeFixture();
    const r = await request(f.app).post('/v1/installs');
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const days = (Date.parse(r.body.expiresAt) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(29.9);
  });

  it('rate-limits installs per IP', async () => {
    const f = makeFixture({ rateInstalls: 2 });
    expect((await request(f.app).post('/v1/installs')).status).toBe(201);
    expect((await request(f.app).post('/v1/installs')).status).toBe(201);
    const r = await request(f.app).post('/v1/installs');
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'rate_limited' });
  });

  it('serves the signed catalog and manifest exactly as stored, and they verify', async () => {
    const f = makeFixture();
    const c = await request(f.app).get('/v1/catalog');
    expect(c.status).toBe(200);
    expect(c.text).toBe(readFileSync(join(f.dir, 'catalog.json'), 'utf8'));
    expect(verifyEnvelope(c.body, f.publicKey)).toBe(true);
    const m = await request(f.app).get('/v1/courses/krakow/manifest');
    expect(m.status).toBe(200);
    expect(verifyEnvelope(m.body, f.publicKey)).toBe(true);
    expect(m.body.payload.courseId).toBe('krakow');
    expect((await request(f.app).get('/v1/courses/nope/manifest')).status).toBe(404);
    expect((await request(f.app).get('/v1/courses/..%2F..%2Fetc/manifest')).status).toBe(404);
    expect((await request(f.app).get('/v1/courses/KRAKOW/manifest')).status).toBe(404);
  });

  it('serves a blob with immutable caching and an ETag, 304 on revalidation', async () => {
    const f = makeFixture();
    const r = await request(f.app).get(`/v1/blobs/${f.blobSha}`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(r.headers.etag).toBe(`"${f.blobSha}"`);
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(Buffer.from(r.body as Buffer).toString()).toBe('{"hello":"pack"}');
    const r2 = await request(f.app).get(`/v1/blobs/${f.blobSha}`).set('If-None-Match', `"${f.blobSha}"`);
    expect(r2.status).toBe(304);
  });

  it('rejects every blob id that is not a lowercase sha256 (no path traversal)', async () => {
    const f = makeFixture();
    const bad = [
      '..%2Fcatalog.json', '..%2F..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fcatalog.json', 'catalog.json',
      f.blobSha.toUpperCase(), f.blobSha.slice(1), `${f.blobSha}0`, `${f.blobSha.slice(0, 62)}..`,
      `..%2F${f.blobSha.slice(3)}`, 'a'.repeat(64)
    ];
    for (const id of bad) {
      const r = await request(f.app).get(`/v1/blobs/${id}`);
      expect(r.status, id).toBe(404);
      expect(r.body).toEqual({ error: 'not_found' });
    }
    expect((await request(f.app).get('/v1/blobs/../catalog.json')).status).toBe(404);
  });
});

describe('POST /v1/tts', () => {
  it('requires a valid install token', async () => {
    const f = makeFixture();
    expect((await request(f.app).post('/v1/tts').send(tts(CACHED_TEXT))).status).toBe(401);
    const bad = await request(f.app).post('/v1/tts').set('Authorization', 'Bearer abc.def').send(tts(CACHED_TEXT));
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'unauthorized' });
    const other = `Bearer ${issueToken('z'.repeat(40)).token}`;
    expect((await request(f.app).post('/v1/tts').set('Authorization', other).send(tts(CACHED_TEXT))).status).toBe(401);
    expect(f.synth.calls).toHaveLength(0);
  });

  it('serves a pre-seeded (shipped) line from the cache without calling ElevenLabs', async () => {
    const f = makeFixture();
    const r = await request(f.app).post('/v1/tts').set('Authorization', auth()).send(tts(CACHED_TEXT));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(r.headers['x-cache']).toBe('hit');
    expect(r.headers['x-text-sha256']).toBe(sha(CACHED_TEXT));
    expect(Buffer.from(r.body as Buffer).equals(CACHED_MP3)).toBe(true);
    expect(f.synth.calls).toHaveLength(0);
  });

  it('rejects text that is not in the course allowed set (403) and never calls upstream', async () => {
    const f = makeFixture();
    const r = await request(f.app).post('/v1/tts').set('Authorization', auth())
      .send(tts('Say anything I want, for free.'));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'not_allowed' });
    expect(f.synth.calls).toHaveLength(0);
    const u = await request(f.app).post('/v1/tts').set('Authorization', auth()).send(tts(CACHED_TEXT, { courseId: 'paris' }));
    expect(u.status).toBe(404);
  });

  it('validates the body (zod, strict) and the 2 kB limit', async () => {
    const f = makeFixture();
    const a = auth();
    for (const body of [{}, tts(''), tts(CACHED_TEXT, { lang: 'de' }), tts(CACHED_TEXT, { extra: 1 }),
      tts('x'.repeat(401)), { courseId: '../x', lang: 'en', text: CACHED_TEXT }]) {
      const r = await request(f.app).post('/v1/tts').set('Authorization', a).send(body);
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const big = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts('x'.repeat(3000)));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'payload_too_large' });
  });

  it('miss: renders once, stores the blob + index + usage, then serves hits', async () => {
    const f = makeFixture();
    const a = auth();
    const r = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT));
    expect(r.status).toBe(200);
    expect(r.headers['x-cache']).toBe('miss');
    expect(Buffer.from(r.body as Buffer).equals(FAKE_MP3)).toBe(true);
    expect(f.synth.calls).toEqual([{ text: ALLOWED_TEXT, lang: 'en' }]);
    const r2 = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT));
    expect(r2.headers['x-cache']).toBe('hit');
    expect(f.synth.calls).toHaveLength(1);
    const idx = JSON.parse(readFileSync(join(f.dir, 'tts-index.json'), 'utf8'));
    expect(idx[sha(ALLOWED_TEXT)].source).toBe('runtime');
    const day = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(readFileSync(join(f.dir, 'usage', `${day}.json`), 'utf8')).chars).toBe(ALLOWED_TEXT.length);
  });

  it('dedupes concurrent identical requests into one upstream call', async () => {
    const f = makeFixture();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    f.synth.impl = async () => {
      await gate;
      return FAKE_MP3;
    };
    const a = auth();
    const reqs = [1, 2, 3, 4].map(() => request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT)).then((x) => x));
    await new Promise((r) => setTimeout(r, 100));
    release();
    const rs = await Promise.all(reqs);
    expect(rs.map((x) => x.status)).toEqual([200, 200, 200, 200]);
    expect(f.synth.calls).toHaveLength(1);
    expect(rs.filter((x) => x.headers['x-cache'] === 'miss')).toHaveLength(1);
  });

  it('enforces the daily character budget with 429', async () => {
    const f = makeFixture({ budget: ALLOWED_TEXT.length + 5 });
    const a = auth();
    expect((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT))).status).toBe(200);
    const r = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(OTHER_ALLOWED));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'budget' });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(f.synth.calls).toHaveLength(1);
    // cache hits still work once the budget is spent
    expect((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(CACHED_TEXT))).status).toBe(200);
  });

  it('opens the circuit breaker on a rejected key: 503 and no further upstream calls; hits still served', async () => {
    const f = makeFixture();
    f.synth.impl = async () => { throw new UpstreamError(401, 'auth'); };
    const a = auth();
    const r = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'tts_unavailable' });
    const r2 = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(OTHER_ALLOWED));
    expect(r2.status).toBe(503);
    expect(Number(r2.headers['retry-after'])).toBeGreaterThan(60);
    expect(f.synth.calls).toHaveLength(1);
    expect((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(CACHED_TEXT))).status).toBe(200);
  });

  it('transient upstream errors: 502, breaker opens after 3 in a row', async () => {
    const f = makeFixture();
    f.synth.impl = async () => { throw new UpstreamError(500, 'server'); };
    const a = auth();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT))).status);
    }
    expect(statuses).toEqual([502, 502, 503, 503]);
    expect(f.synth.calls).toHaveLength(3);
  });

  it('rate-limits per token + IP', async () => {
    const f = makeFixture({ rateTts: 2 });
    const a = auth();
    const b = auth();
    expect((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(CACHED_TEXT))).status).toBe(200);
    expect((await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(CACHED_TEXT))).status).toBe(200);
    const r = await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(CACHED_TEXT));
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: 'rate_limited' });
    expect((await request(f.app).post('/v1/tts').set('Authorization', b).send(tts(CACHED_TEXT))).status).toBe(200);
  });
});

describe('error handling and logs', () => {
  it('hides stack traces and messages: unexpected errors are a bare 500', async () => {
    const f = makeFixture();
    f.synth.impl = async () => { throw new Error('secret internal detail at /srv/x.ts:12'); };
    const r = await request(f.app).post('/v1/tts').set('Authorization', auth()).send(tts(ALLOWED_TEXT));
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'internal' });
    expect(r.text).not.toMatch(/secret internal|at |\.ts/);
  });

  it('malformed JSON is a 400 without parser details', async () => {
    const f = makeFixture();
    const r = await request(f.app).post('/v1/tts').set('Authorization', auth())
      .set('Content-Type', 'application/json').send('{"courseId": ');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'bad_request' });
    expect(r.text).not.toMatch(/Unexpected|SyntaxError|at /);
  });

  it('unknown routes are a JSON 404', async () => {
    const f = makeFixture();
    const r = await request(f.app).get('/admin');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
  });

  it('never logs the token, the Authorization header or the text', async () => {
    const f = makeFixture();
    const a = auth();
    await request(f.app).post('/v1/tts').set('Authorization', a).send(tts(ALLOWED_TEXT));
    await request(f.app).post('/v1/tts').set('Authorization', a).send(tts('Not allowed text here'));
    const all = f.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(a.slice(7));
    expect(all).not.toContain(ALLOWED_TEXT);
    expect(all).not.toContain('Not allowed text here');
    expect(all).not.toMatch(/authorization/i);
    expect(all).toContain(sha(ALLOWED_TEXT));
    expect(all).not.toContain('remoteAddress');
  });
});
