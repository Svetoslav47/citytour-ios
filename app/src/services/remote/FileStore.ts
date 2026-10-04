/*
 * Async file helpers for downloaded courses and the runtime voice cache (docs/SERVER.md §6). Everything here is
 * Promise-based so hashing and IO of course files never block the JS thread for long (HarmonyOS once killed the app
 * with THREAD_BLOCK_6S for main-thread work).
 * Every function resolves (never rejects): failures are reported as false / undefined / '' and logged by callers.
 *
 * iOS port (HarmonyOS Core File Kit fileIo + Crypto Architecture Kit -> Expo):
 *   - expo-file-system/legacy async functions (getInfoAsync, makeDirectoryAsync, deleteAsync, moveAsync,
 *     readDirectoryAsync, writeAsStringAsync) run on native queues; the new API reads bytes/text asynchronously
 *     (File.bytes(), File.text()) and writes bytes natively (File.write(Uint8Array), a short synchronous memcpy).
 *   - SHA-256: expo-crypto digest(SHA256, bytes) (async, native CommonCrypto).
 *
 * PATH CONVENTION: every "path" in services/remote and services/pack is a `file://` URI string, built by
 * concatenating '/'-separated segments onto filesDir. filesDir on iOS is `Paths.document.uri` WITHOUT its trailing
 * slash (e.g. 'file:///var/mobile/.../Documents'). The resulting strings go straight to expo-audio and expo-image,
 * which take file:// URIs. toUri() also accepts a plain absolute path ('/var/...') and collapses accidental '//', so a
 * caller that passes a path or a trailing-slash filesDir still works.
 */
import * as Legacy from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';

export function hexOf(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return s;
}

/** A file:// URI for a URI or an absolute path ('//' inside the path collapsed). */
export function toUri(path: string): string {
  let p = path;
  if (!p.startsWith('file://')) {
    p = p.startsWith('/') ? `file://${p}` : `file:///${p}`;
  }
  return 'file://' + p.substring('file://'.length).replace(/\/{2,}/g, '/');
}

/** UTF-8 bytes -> string (a leading BOM is dropped). Uses TextDecoder when the runtime has one. */
export function utf8Decode(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: new (label?: string) => { decode(b: Uint8Array): string } }).TextDecoder;
  let s: string;
  if (TD !== undefined) {
    s = new TD('utf-8').decode(bytes);
  } else {
    const parts: string[] = [];
    let chunk: number[] = [];
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      let cp = 0xFFFD;
      let n = 1;
      if (b < 0x80) {
        cp = b;
      } else if (b >= 0xC2 && b < 0xE0 && i + 1 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80) {
        cp = ((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F);
        n = 2;
      } else if (b >= 0xE0 && b < 0xF0 && i + 2 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80 &&
        (bytes[i + 2] & 0xC0) === 0x80) {
        cp = ((b & 0x0F) << 12) | ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F);
        n = 3;
      } else if (b >= 0xF0 && b < 0xF5 && i + 3 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80 &&
        (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) {
        cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) | ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        n = 4;
      }
      if (cp > 0xFFFF) {
        cp -= 0x10000;
        chunk.push(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      } else {
        chunk.push(cp);
      }
      i += n;
      if (chunk.length >= 8192) {
        parts.push(String.fromCharCode.apply(null, chunk));
        chunk = [];
      }
    }
    parts.push(String.fromCharCode.apply(null, chunk));
    s = parts.join('');
  }
  return s.charCodeAt(0) === 0xFEFF ? s.substring(1) : s;
}

function parentOf(uri: string): string {
  const slash = uri.lastIndexOf('/');
  return slash > 'file://'.length ? uri.substring(0, slash) : '';
}

export class FileStore {
  static async exists(path: string): Promise<boolean> {
    try {
      return (await Legacy.getInfoAsync(toUri(path))).exists;
    } catch (e) {
      return false;
    }
  }

  static async mkdirs(path: string): Promise<boolean> {
    try {
      if (await FileStore.exists(path)) {
        return true;
      }
      await Legacy.makeDirectoryAsync(toUri(path), { intermediates: true });
      return true;
    } catch (e) {
      // Parallel downloads race to create the same folder: another worker may have won.
      if (await FileStore.exists(path)) {
        return true;
      }
      Log.w(LogEvents.COURSE, `event=mkdir_fail path=${path} ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  /** rm -rf; true when the path is gone afterwards. */
  static async remove(path: string): Promise<boolean> {
    try {
      if (!(await FileStore.exists(path))) {
        return true;
      }
      await Legacy.deleteAsync(toUri(path), { idempotent: true });
      return true;
    } catch (e) {
      Log.w(LogEvents.COURSE, `event=remove_fail path=${path} ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  /** Moves `from` to `to`; like POSIX rename, an existing FILE at `to` is replaced (a folder must not exist). */
  static async rename(from: string, to: string): Promise<boolean> {
    try {
      const dest = toUri(to);
      const info = await Legacy.getInfoAsync(dest);
      if (info.exists && !info.isDirectory) {
        await Legacy.deleteAsync(dest, { idempotent: true });
      }
      await Legacy.moveAsync({ from: toUri(from), to: dest });
      return true;
    } catch (e) {
      Log.w(LogEvents.COURSE, `event=rename_fail from=${from} to=${to} ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  /** Names (not paths) of the entries of a folder; [] when it is missing. */
  static async list(dir: string): Promise<string[]> {
    try {
      return await Legacy.readDirectoryAsync(toUri(dir));
    } catch (e) {
      return [];
    }
  }

  /** Size in bytes, or -1 when the path does not exist. */
  static async size(path: string): Promise<number> {
    try {
      const info = await Legacy.getInfoAsync(toUri(path));
      return info.exists ? info.size : -1;
    } catch (e) {
      return -1;
    }
  }

  /** Writes bytes to a new file (truncating), creating its folder. */
  static async writeBytes(path: string, data: ArrayBuffer): Promise<boolean> {
    try {
      const uri = toUri(path);
      const parent = parentOf(uri);
      if (parent !== '' && !(await FileStore.mkdirs(parent))) {
        return false;
      }
      new File(uri).write(new Uint8Array(data));
      return true;
    } catch (e) {
      Log.w(LogEvents.COURSE, `event=write_fail path=${path} ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  static async writeText(path: string, text: string): Promise<boolean> {
    try {
      const uri = toUri(path);
      const parent = parentOf(uri);
      if (parent !== '' && !(await FileStore.mkdirs(parent))) {
        return false;
      }
      await Legacy.writeAsStringAsync(uri, text, { encoding: Legacy.EncodingType.UTF8 });
      return true;
    } catch (e) {
      Log.w(LogEvents.COURSE, `event=write_text_fail path=${path} ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  /** UTF-8 text of a file, or undefined. */
  static async readText(path: string): Promise<string | undefined> {
    const bytes = await FileStore.readBytes(path);
    if (bytes === undefined) {
      return undefined;
    }
    try {
      return utf8Decode(bytes);
    } catch (e) {
      return undefined;
    }
  }

  /** All bytes of a file (async, native read), or undefined. */
  static async readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      const size = await FileStore.size(path);
      if (size < 0) {
        return undefined;
      }
      const out = await new File(toUri(path)).bytes();
      return out.length === size ? out : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /** Lowercase hex SHA-256 of a file (async read + async native digest); '' on any error. */
  static async sha256File(path: string): Promise<string> {
    try {
      const bytes = await FileStore.readBytes(path);
      if (bytes === undefined) {
        Log.w(LogEvents.COURSE, `event=sha_fail path=${path} code=-1 msg=unreadable`);
        return '';
      }
      const d = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>);
      return hexOf(new Uint8Array(d));
    } catch (e) {
      Log.w(LogEvents.COURSE, `event=sha_fail path=${path} ${Log.errKv(e as Object)}`);
      return '';
    }
  }

  /** Hex SHA-256 of bytes in memory (async native digest). '' on error. */
  static async sha256Bytes(data: Uint8Array): Promise<string> {
    try {
      const d = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>);
      return hexOf(new Uint8Array(d));
    } catch (e) {
      return '';
    }
  }
}
