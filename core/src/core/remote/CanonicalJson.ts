/*
 * Canonical JSON and base64 for the signed server envelopes (docs/SERVER.md §3 "Signatures"). Pure: no @kit imports,
 * unit-tested in entry/src/test/RemoteEnvelope.test.ets against vectors computed with Node.
 *
 * canonicalJson(v): the exact UTF-16 string whose UTF-8 bytes the server signs with Ed25519:
 *   - object keys sorted recursively by UTF-16 code units (JavaScript's default Array.sort, = RFC 8785 key order),
 *   - no whitespace,
 *   - strings and numbers serialized as JSON.stringify does (ES number formatting, the same as Node),
 *   - null, true, false as literals; a non-finite number (never produced by JSON.parse) as null.
 * Node equivalent (what the server's publish CLI must use):
 *   const c = (v) => Array.isArray(v) ? `[${v.map(c).join(',')}]` : v !== null && typeof v === 'object'
 *     ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${c(v[k])}`).join(',')}}` : JSON.stringify(v);
 */

/** Canonical JSON of a value obtained from JSON.parse. Never throws. */
export function canonicalJson(v: Object | null | undefined): string {
  if (v === null || v === undefined) {
    return 'null';
  }
  if (typeof v === 'string') {
    return JSON.stringify(v as string);
  }
  if (typeof v === 'number') {
    const n = v as number;
    return Number.isFinite(n) ? JSON.stringify(n) : 'null';
  }
  if (typeof v === 'boolean') {
    return (v as boolean) ? 'true' : 'false';
  }
  if (Array.isArray(v)) {
    const arr = v as Object[];
    const parts: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      parts.push(canonicalJson(arr[i]));
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof v === 'object') {
    const rec = v as Record<string, Object>;
    const keys: string[] = Object.keys(rec).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const child: Object | undefined = rec[k];
      if (child === undefined) {
        continue;   // JSON.stringify drops undefined members too
      }
      parts.push(`${JSON.stringify(k)}:${canonicalJson(child)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

const B64: string = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64Value(c: string): number {
  if (c === '-') {
    return 62;   // base64url
  }
  if (c === '_') {
    return 63;
  }
  return B64.indexOf(c);
}

/** Standard or URL-safe base64 (padding optional, whitespace ignored) -> bytes; undefined when malformed. */
export function base64Decode(s: string): number[] | undefined {
  let clean = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
      continue;
    }
    clean += c;
  }
  while (clean.endsWith('=')) {
    clean = clean.substring(0, clean.length - 1);
  }
  if (clean.length % 4 === 1) {
    return undefined;
  }
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = b64Value(clean.charAt(i));
    if (v < 0) {
      return undefined;
    }
    buf = ((buf << 6) | v) & 0xFFFFFF;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xFF);
    }
  }
  return out;
}
