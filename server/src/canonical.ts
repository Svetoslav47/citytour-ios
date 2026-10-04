// Canonical JSON + Ed25519 envelopes (docs/SERVER.md §3 "Canonical JSON"). The app reproduces canonicalJson()
// byte for byte, so keep it boring:
//   - objects: keys sorted ascending by UTF-16 code units (JavaScript's default sort; all our keys are ASCII, so
//     this is plain byte order), no duplicate keys, members whose value is undefined are not allowed;
//   - arrays keep their order;
//   - strings and numbers are written exactly as JSON.stringify writes them (ECMAScript Number::toString, no
//     NaN/Infinity, -0 written as 0), true/false/null as is;
//   - no whitespace anywhere; the result is encoded as UTF-8 and those bytes are signed.
import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('canonicalJson: non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) {
          throw new Error(`canonicalJson: undefined value at key ${JSON.stringify(k)}`);
        }
        parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export interface Envelope<T> {
  payload: T;
  sig: string;      // base64 Ed25519 signature over utf8(canonicalJson(payload))
}

export function signPayload<T>(payload: T, privateKey: KeyObject): Envelope<T> {
  const msg = Buffer.from(canonicalJson(payload), 'utf8');
  return { payload, sig: sign(null, msg, privateKey).toString('base64') };
}

export function verifyEnvelope(env: { payload: unknown; sig: unknown }, publicKey: KeyObject): boolean {
  if (typeof env.sig !== 'string' || env.sig.length === 0) {
    return false;
  }
  try {
    const msg = Buffer.from(canonicalJson(env.payload), 'utf8');
    return verify(null, msg, publicKey, Buffer.from(env.sig, 'base64'));
  } catch {
    return false;
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function loadPrivateKey(pem: string): KeyObject {
  const k = createPrivateKey(pem);
  if (k.asymmetricKeyType !== 'ed25519') {
    throw new Error('SIGNING_PRIVATE_KEY is not an Ed25519 key');
  }
  return k;
}

/** Public key from PEM, SPKI DER base64, or the raw 32-byte key in base64. */
export function loadPublicKey(s: string): KeyObject {
  const t = s.trim();
  if (t.startsWith('-----BEGIN')) {
    return createPublicKey(t);
  }
  const der = Buffer.from(t, 'base64');
  if (der.length === 32) {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: der.toString('base64url') }, format: 'jwk' });
  }
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** The three encodings the app may want: raw 32 bytes (base64), SPKI DER (base64) and PEM. */
export function publicKeyForms(pub: KeyObject): { raw: string; spkiDer: string; pem: string } {
  const jwk = pub.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new Error('not an OKP key');
  }
  return {
    raw: Buffer.from(jwk.x, 'base64url').toString('base64'),
    spkiDer: (pub.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
    pem: String(pub.export({ format: 'pem', type: 'spki' }))
  };
}
