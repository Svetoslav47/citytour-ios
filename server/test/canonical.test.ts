import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson, loadPublicKey, publicKeyForms, sha256Hex, signPayload, verifyEnvelope
} from '../src/canonical.js';
import { issueToken, verifyToken } from '../src/tokens.js';

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order, no whitespace', () => {
    const v = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' }, A: 2 };
    expect(canonicalJson(v)).toBe('{"A":2,"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it('writes strings and numbers exactly as JSON.stringify (UTF-8, escapes)', () => {
    expect(canonicalJson({ t: 'Kraków 皇家之路 "q" \n  ', n: 2.5, i: 40307550, z: -0, e: 1e21 }))
      .toBe('{"e":1e+21,"i":40307550,"n":2.5,"t":"Kraków 皇家之路 \\"q\\" \\n  ","z":0}');
    expect(sha256Hex(Buffer.from(canonicalJson({ k: 'ó' }), 'utf8')))
      .toBe(sha256Hex(Buffer.from('{"k":"ó"}', 'utf8')));
  });

  it('is independent of the input key order', () => {
    expect(canonicalJson({ x: 1, y: { b: 2, a: 1 } })).toBe(canonicalJson({ y: { a: 1, b: 2 }, x: 1 }));
  });

  it('rejects values JSON cannot represent', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: Infinity })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
  });
});

describe('Ed25519 envelopes', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = { courses: [{ id: 'krakow', title: { en: 'The Royal Route', zh: '皇家之路' }, km: 2.1 }] };

  it('round-trips and survives re-serialisation with another key order', () => {
    const env = signPayload(payload, privateKey);
    expect(verifyEnvelope(env, publicKey)).toBe(true);
    const reparsed = JSON.parse(JSON.stringify({ sig: env.sig, payload: { courses: [{ km: 2.1, title: {
      zh: '皇家之路', en: 'The Royal Route' }, id: 'krakow' }] } })) as typeof env;
    expect(verifyEnvelope(reparsed, publicKey)).toBe(true);
  });

  it('rejects a tampered payload, a wrong key and a missing signature', () => {
    const env = signPayload(payload, privateKey);
    expect(verifyEnvelope({ ...env, payload: { courses: [] } }, publicKey)).toBe(false);
    expect(verifyEnvelope(env, generateKeyPairSync('ed25519').publicKey)).toBe(false);
    expect(verifyEnvelope({ payload, sig: '' }, publicKey)).toBe(false);
  });

  it('loads the public key from raw base64, SPKI DER base64 and PEM', () => {
    const env = signPayload(payload, privateKey);
    const f = publicKeyForms(publicKey);
    expect(Buffer.from(f.raw, 'base64')).toHaveLength(32);
    for (const s of [f.raw, f.spkiDer, f.pem]) {
      expect(verifyEnvelope(env, loadPublicKey(s))).toBe(true);
    }
  });
});

describe('install tokens', () => {
  const secret = 'x'.repeat(40);

  it('verifies its own token and rejects tampering, another secret and expiry', () => {
    const { token, claims } = issueToken(secret, 1000);
    expect(verifyToken(secret, token, 1001)).toEqual(claims);
    expect(claims.exp - claims.iat).toBe(30 * 24 * 3600);
    expect(verifyToken('y'.repeat(40), token, 1001)).toBeNull();
    expect(verifyToken(secret, token, claims.exp)).toBeNull();
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 999999 })).toString('base64url');
    expect(verifyToken(secret, `${forged}.${sig}`, 1001)).toBeNull();
    expect(verifyToken(secret, `${body}.`, 1001)).toBeNull();
    expect(verifyToken(secret, 'garbage', 1001)).toBeNull();
  });
});
