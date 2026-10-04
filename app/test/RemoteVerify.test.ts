// Suite: services/remote/SignatureVerifier (iOS port: @noble/ed25519 with the raw key from the SPKI DER).
// Cases: the committed server/seed envelopes (catalog, a course manifest, a city manifest) verify with the production
// key in RemoteConfig over core's canonical JSON; a tampered payload, a wrong key, a malformed key and no key fail
// closed; rawKeyFromSpki only accepts a 44-byte Ed25519 SPKI.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseEnvelope } from '@citytour/core';
import { RemoteConfig } from '../src/main/RemoteConfig';
import { Ed25519Verifier, rawKeyFromSpki } from '../src/services/remote/SignatureVerifier';

const SEED = resolve(__dirname, '../../server/seed');
const seeds = ['catalog.json', 'courses/krakow/manifest.json', 'cities/krakow/manifest.json'];

describe('Ed25519Verifier', () => {
  for (const name of seeds) {
    it(`verifies seed ${name}`, async () => {
      const env = parseEnvelope(readFileSync(`${SEED}/${name}`, 'utf8'));
      expect(env.error).toBe('');
      const v = new Ed25519Verifier(RemoteConfig.SIGNING_PUBLIC_KEY_SPKI_B64);
      expect(await v.verify(env.canonical, env.sig)).toBe(true);
    });
  }

  it('rejects a tampered payload', async () => {
    const env = parseEnvelope(readFileSync(`${SEED}/catalog.json`, 'utf8'));
    const v = new Ed25519Verifier(RemoteConfig.SIGNING_PUBLIC_KEY_SPKI_B64);
    expect(await v.verify(env.canonical.replace('krakow', 'krakoW'), env.sig)).toBe(false);
    const sig = env.sig.slice();
    sig[5] ^= 1;
    expect(await v.verify(env.canonical, sig)).toBe(false);
  });

  it('rejects with another, a malformed or no key', async () => {
    const env = parseEnvelope(readFileSync(`${SEED}/catalog.json`, 'utf8'));
    // a different valid SPKI key (RFC 8032 test 1 public key)
    const other = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')]).toString('base64');
    expect(await new Ed25519Verifier(other).verify(env.canonical, env.sig)).toBe(false);
    expect(await new Ed25519Verifier('not base64 !!').verify(env.canonical, env.sig)).toBe(false);
    const none = new Ed25519Verifier('  ');
    expect(none.configured()).toBe(false);
    expect(await none.verify(env.canonical, env.sig)).toBe(false);
  });

  it('extracts the raw key from SPKI only', () => {
    const raw = rawKeyFromSpki(RemoteConfig.SIGNING_PUBLIC_KEY_SPKI_B64);
    expect(raw?.length).toBe(32);
    expect(Buffer.from(raw as Uint8Array).toString('hex'))
      .toBe(Buffer.from(RemoteConfig.SIGNING_PUBLIC_KEY_SPKI_B64, 'base64').subarray(12).toString('hex'));
    expect(rawKeyFromSpki(Buffer.alloc(32, 7).toString('base64'))).toBeUndefined();
    expect(rawKeyFromSpki(Buffer.alloc(44, 7).toString('base64'))).toBeUndefined();
  });
});
