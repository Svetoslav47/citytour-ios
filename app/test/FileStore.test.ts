// Suite: services/remote/FileStore + CourseStore + ClipManifestTask (iOS port) against a node:fs-backed fake of
// expo-file-system (legacy + new API, with iOS semantics: move fails onto an existing target) and expo-crypto.
// Cases: URI convention (toUri), utf8Decode, mkdirs/write/read/size/list/rename/remove, sha256; CourseStore.install
// swaps a verified temp folder in atomically, keeps the temp folder after a bad blob and resumes from it, removes it on
// cancel, and installed()/readActive() read back what was written; courseClipsOffThread joins root + clip path.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('expo-file-system/legacy', async () => {
  const fs = await import('fs');
  const p = (u: string) => decodeURI(u.replace(/^file:\/\//, ''));
  return {
    EncodingType: { UTF8: 'utf8', Base64: 'base64' },
    getInfoAsync: async (u: string) => {
      try {
        const st = fs.statSync(p(u));
        return { exists: true, uri: u, size: st.size, isDirectory: st.isDirectory(), modificationTime: 0 };
      } catch {
        return { exists: false, uri: u, isDirectory: false };
      }
    },
    makeDirectoryAsync: async (u: string, o?: { intermediates?: boolean }) => {
      fs.mkdirSync(p(u), { recursive: o?.intermediates === true });
    },
    deleteAsync: async (u: string) => fs.rmSync(p(u), { recursive: true, force: true }),
    moveAsync: async (o: { from: string; to: string }) => {
      if (fs.existsSync(p(o.to))) {
        throw new Error('item already exists');   // FileManager.moveItem semantics
      }
      fs.renameSync(p(o.from), p(o.to));
    },
    readDirectoryAsync: async (u: string) => fs.readdirSync(p(u)),
    writeAsStringAsync: async (u: string, t: string) => fs.writeFileSync(p(u), t, 'utf8')
  };
});
vi.mock('expo-file-system', async () => {
  const fs = await import('fs');
  const p = (u: string) => decodeURI(u.replace(/^file:\/\//, ''));
  class File {
    uri: string;
    constructor(u: string) {
      this.uri = u;
    }
    write(c: string | Uint8Array): void {
      fs.writeFileSync(p(this.uri), c);
    }
    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(fs.readFileSync(p(this.uri)));
    }
    bytesSync(): Uint8Array {
      return new Uint8Array(fs.readFileSync(p(this.uri)));
    }
    get size(): number {
      return fs.existsSync(p(this.uri)) ? fs.statSync(p(this.uri)).size : 0;
    }
  }
  return { File };
});
vi.mock('expo-crypto', async () => {
  const c = await import('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digest: async (_a: string, d: Uint8Array) => {
      const b = c.createHash('sha256').update(d).digest();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
  };
});

import { CourseFile, CourseManifest, CourseSummary } from '@citytour/core';
import { FileStore, toUri, utf8Decode } from '../src/services/remote/FileStore';
import { CancelToken, CourseStore } from '../src/services/remote/CourseStore';
import { HttpOutcome, RemoteClient } from '../src/services/remote/RemoteClient';
import { courseClipsOffThread } from '../src/services/remote/ClipManifestTask';
import { FilePackSource } from '../src/services/pack/FilePackRepository';

const base = mkdtempSync(join(tmpdir(), 'citytour-fs-'));
const DIR = `file://${base}`;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

describe('FileStore', () => {
  it('normalizes paths to file URIs', () => {
    expect(toUri('/a/b')).toBe('file:///a/b');
    expect(toUri('file:///a//b/')).toBe('file:///a/b/');
    expect(toUri('file:///a/b')).toBe('file:///a/b');
  });

  it('decodes utf-8 (BOM dropped)', () => {
    const s = 'Kraków 皇家之路 😀';
    expect(utf8Decode(new Uint8Array(Buffer.from(s, 'utf8')))).toBe(s);
    expect(utf8Decode(new Uint8Array(Buffer.from('﻿{"a":1}', 'utf8')))).toBe('{"a":1}');
  });

  it('writes, reads, hashes, lists, renames and removes', async () => {
    const f = `${DIR}/x/y/z.bin`;
    const data = new Uint8Array([1, 2, 3, 250]);
    expect(await FileStore.writeBytes(f, data.buffer)).toBe(true);
    expect(await FileStore.size(f)).toBe(4);
    expect(Array.from((await FileStore.readBytes(f)) as Uint8Array)).toEqual([1, 2, 3, 250]);
    expect(await FileStore.sha256File(f)).toBe(sha(data));
    expect(await FileStore.sha256Bytes(data)).toBe(sha(data));
    expect(await FileStore.writeText(`${DIR}/x/t.json`, '{"zh":"皇家"}')).toBe(true);
    expect(await FileStore.readText(`${DIR}/x/t.json`)).toBe('{"zh":"皇家"}');
    expect((await FileStore.list(`${DIR}/x`)).sort()).toEqual(['t.json', 'y']);
    expect(await FileStore.writeText(`${DIR}/x/u.json`, 'old')).toBe(true);
    expect(await FileStore.rename(`${DIR}/x/t.json`, `${DIR}/x/u.json`)).toBe(true);   // replaces a file
    expect(await FileStore.readText(`${DIR}/x/u.json`)).toBe('{"zh":"皇家"}');
    expect(await FileStore.mkdirs(`${DIR}/x/y`)).toBe(true);
    expect(await FileStore.remove(`${DIR}/x`)).toBe(true);
    expect(await FileStore.exists(`${DIR}/x`)).toBe(false);
    expect(await FileStore.size(`${DIR}/x/u.json`)).toBe(-1);
    expect(await FileStore.readText(`${DIR}/missing`)).toBeUndefined();
    expect(await FileStore.list(`${DIR}/missing`)).toEqual([]);
  });
});

function fileOf(path: string, body: string): [CourseFile, Uint8Array] {
  const b = new Uint8Array(Buffer.from(body, 'utf8'));
  const f = new CourseFile();
  f.path = path;
  f.sha256 = sha(b);
  f.bytes = b.length;
  return [f, b];
}

function fakeClient(blobs: Map<string, Uint8Array>, corrupt: Set<string>): RemoteClient {
  return {
    blob: async (s: string): Promise<HttpOutcome> => {
      const o = new HttpOutcome();
      const b = blobs.get(s);
      if (b === undefined) {
        o.status = 404;
        return o;
      }
      o.status = 200;
      const c = corrupt.has(s) ? b.map((x) => x ^ 1) : b;
      o.bytes = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer;
      return o;
    }
  } as unknown as RemoteClient;
}

describe('CourseStore.install', () => {
  const files = [fileOf('pack/manifest.json', '{"schemaVersion":1}'), fileOf('pack/pois.json', '[]'),
    fileOf('audio/manifest.json', '{"clips":[]}'), fileOf('audio/en/a.mp3', 'MP3DATA')];
  const m = new CourseManifest();
  m.courseId = 'gdansk';
  m.version = '3';
  m.files = files.map((x) => x[0]);
  const blobs = new Map<string, Uint8Array>(files.map((x) => [x[0].sha256, x[1]]));
  const summary = new CourseSummary();
  summary.id = 'gdansk';
  summary.version = '3';
  summary.title.en = 'Gdańsk';
  const store = new CourseStore(() => DIR);

  it('keeps the temp folder after a bad blob, then resumes and swaps in', async () => {
    const corrupt = new Set<string>([files[3][0].sha256]);
    const r1 = await store.install(fakeClient(blobs, corrupt), m, summary, new CancelToken(), () => {});
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('sha256_mismatch');
    expect(await FileStore.exists(`${DIR}/courses/gdansk/3`)).toBe(false);
    expect(await FileStore.exists(`${DIR}/courses/.tmp/gdansk-3`)).toBe(true);
    let resumed = 0;
    const r2 = await store.install(fakeClient(blobs, new Set()), m, summary, new CancelToken(),
      (p) => { resumed = p.resumedFiles; });
    expect(r2.ok).toBe(true);
    expect(resumed).toBeGreaterThan(0);
    expect(await FileStore.exists(`${DIR}/courses/.tmp/gdansk-3`)).toBe(false);
    expect(await FileStore.readText(`${DIR}/courses/gdansk/3/audio/en/a.mp3`)).toBe('MP3DATA');
    const inst = await store.installed();
    expect(inst.map((r) => `${r.id}@${r.version}`)).toEqual(['gdansk@3']);
    expect(inst[0].summary.title.en).toBe('Gdańsk');
    expect(store.packPath(inst[0])).toBe(`${DIR}/courses/gdansk/3/pack`);
    const src = new FilePackSource(store.packPath(inst[0]));
    expect(Buffer.from(src.readSync('pois.json')).toString()).toBe('[]');
    expect(Buffer.from(await src.read('manifest.json')).toString()).toBe('{"schemaVersion":1}');
  });

  it('a new version replaces the old one; cancel forgets the partial download', async () => {
    const m4 = Object.assign(new CourseManifest(), m, { version: '4' });
    const r = await store.install(fakeClient(blobs, new Set()), m4, summary, new CancelToken(), () => {});
    expect(r.ok).toBe(true);
    expect(await FileStore.list(`${DIR}/courses/gdansk`)).toEqual(['4']);
    const m5 = Object.assign(new CourseManifest(), m, { version: '5' });
    const cancel = new CancelToken();
    cancel.cancelled = true;
    const rc = await store.install(fakeClient(blobs, new Set()), m5, summary, cancel, () => {});
    expect(rc.error).toBe('cancelled');
    expect(await FileStore.exists(`${DIR}/courses/.tmp/gdansk-5`)).toBe(false);
    await store.writeActive('gdansk');
    expect(await store.readActive()).toBe('gdansk');
  });
});

describe('courseClipsOffThread', () => {
  it('joins the root and returns [] for junk', async () => {
    expect(await courseClipsOffThread('not json', `${DIR}/c`)).toEqual([]);
  });
});
