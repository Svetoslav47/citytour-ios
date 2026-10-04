import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import { sha256Hex, signPayload } from '../src/canonical.js';
import { createLogger } from '../src/log.js';
import { DataStore, TtsIndex } from '../src/store.js';
import { CircuitBreaker } from '../src/tts/breaker.js';
import { SynthRequest, Synthesizer } from '../src/tts/elevenlabs.js';
import { TtsService } from '../src/tts/service.js';

export const SECRET = 'test-secret-test-secret-test-secret-0123456789';
export const ALLOWED_TEXT = 'In about 80 metres, on your left: Barbican.';
export const CACHED_TEXT = 'You\'re at Barbican.';
export const OTHER_ALLOWED = 'Next stop: Barbican, about 6 minutes from here.';
export const FAKE_MP3 = Buffer.alloc(1024, 7);
export const CACHED_MP3 = Buffer.alloc(900, 3);

export class MockSynth implements Synthesizer {
  calls: SynthRequest[] = [];
  impl: (r: SynthRequest) => Promise<Buffer> = async () => FAKE_MP3;
  async synthesize(r: SynthRequest): Promise<Buffer> {
    this.calls.push(r);
    return this.impl(r);
  }
}

export interface Fixture {
  dir: string;
  store: DataStore;
  synth: MockSynth;
  breaker: CircuitBreaker;
  app: ReturnType<typeof createApp>;
  logs: string[];
  publicKey: KeyObject;
  privateKey: KeyObject;
  blobSha: string;
}

export function sha(s: string): string {
  return sha256Hex(Buffer.from(s, 'utf8'));
}

export function makeFixture(o: { budget?: number; rateInstalls?: number; rateTts?: number } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'citytour-srv-'));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  mkdirSync(join(dir, 'blobs'), { recursive: true });
  mkdirSync(join(dir, 'courses', 'krakow'), { recursive: true });
  const blob = Buffer.from('{"hello":"pack"}');
  const blobSha = sha256Hex(blob);
  writeFileSync(join(dir, 'blobs', blobSha), blob);
  const cachedBlobSha = sha256Hex(CACHED_MP3);
  writeFileSync(join(dir, 'blobs', cachedBlobSha), CACHED_MP3);
  const allowed = [ALLOWED_TEXT, CACHED_TEXT, OTHER_ALLOWED].map(sha).sort();
  const allowedBytes = JSON.stringify(allowed);
  writeFileSync(join(dir, 'courses', 'krakow', 'allowed.json'), allowedBytes);
  const manifest = {
    schemaVersion: 1, courseId: 'krakow', version: 'v1', publishedAt: '2026-10-03T00:00:00.000Z', packId: 'krakow',
    files: [{ path: 'packs/krakow/tours.json', sha256: blobSha, bytes: blob.length }],
    audio: { manifestPath: 'audio/manifest.json', clips: 0 }, allowedTtsSha: sha256Hex(allowedBytes)
  };
  writeFileSync(join(dir, 'courses', 'krakow', 'manifest.json'), JSON.stringify(signPayload(manifest, privateKey)));
  const catalog = { courses: [{ id: 'krakow', version: 'v1', title: { en: 'The Royal Route', pl: 'Droga Królewska',
    zh: '皇家之路' }, city: 'Kraków', stops: 11, km: 2, minutes: 55, langs: ['en', 'pl', 'zh'], bytes: blob.length }] };
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(signPayload(catalog, privateKey)));
  const idx: TtsIndex = {
    [sha(CACHED_TEXT)]: { blob: cachedBlobSha, chars: CACHED_TEXT.length, lang: 'en', source: 'shipped', renderedAt: '' }
  };
  writeFileSync(join(dir, 'tts-index.json'), JSON.stringify(idx));

  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    }
  });
  const log = createLogger('info', sink);
  const store = new DataStore(dir);
  const synth = new MockSynth();
  const breaker = new CircuitBreaker();
  const tts = new TtsService(store, synth, breaker, o.budget ?? 10000, log);
  const app = createApp({
    store, tts, log, tokenSecret: SECRET, version: 'test', trustProxy: false,
    rateInstallsPerHour: o.rateInstalls ?? 100, rateTtsPer10Min: o.rateTts ?? 1000
  });
  return { dir, store, synth, breaker, app, logs, publicKey, privateKey, blobSha };
}
