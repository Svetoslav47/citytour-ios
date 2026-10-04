/*
 * Verifies the Ed25519 signature of a signed server envelope (docs/SERVER.md §3 "Signatures").
 * HarmonyOS used Crypto Architecture Kit (convertKey of the SPKI DER + createVerify('Ed25519')). iOS/Hermes has no
 * WebCrypto, so this uses @noble/ed25519 v3 (pure JS): the public key is the base64 DER SubjectPublicKeyInfo
 * (44 bytes: the 12-byte prefix 302a300506032b6570032100 + the raw 32-byte key), verifyAsync(sig, msg, rawKey).
 * noble's default async SHA-512 needs crypto.subtle, which Hermes lacks, so its hash is set to @noble/hashes sha512.
 * Ed25519 is single-shot: the whole message (utf8 of the canonical JSON) is verified at once.
 * The verifier is behind an interface so a test or another algorithm can replace it.
 * Fails closed: an empty or malformed key, or any crypto error, means "not verified".
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { Log } from '../../app/Log';
import { base64Decode, LogEvents, utf8Bytes } from '@citytour/core';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING }. */
const SPKI_PREFIX: number[] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const SPKI_LEN: number = 44;

let hashesReady = false;

function ensureHashes(): void {
  if (hashesReady) {
    return;
  }
  hashesReady = true;
  ed.hashes.sha512 = (m) => sha512(m);
  ed.hashes.sha512Async = (m) => Promise.resolve(sha512(m));
}

/** The raw 32-byte Ed25519 key of a base64 SPKI DER key, or undefined when it is not one. */
export function rawKeyFromSpki(spkiB64: string): Uint8Array | undefined {
  const der = base64Decode(spkiB64);
  if (der === undefined || der.length !== SPKI_LEN) {
    return undefined;
  }
  for (let i = 0; i < SPKI_PREFIX.length; i++) {
    if (der[i] !== SPKI_PREFIX[i]) {
      return undefined;
    }
  }
  return new Uint8Array(der.slice(SPKI_LEN - 32));
}

export interface SignatureVerifier {
  /** True only when `sig` is a valid signature of utf8(`message`). Never rejects. */
  verify(message: string, sig: number[]): Promise<boolean>;
  /** False when no public key is configured (everything is rejected). */
  configured(): boolean;
}

export class Ed25519Verifier implements SignatureVerifier {
  private readonly spkiB64: string;
  private key: Promise<Uint8Array | undefined> | undefined = undefined;

  constructor(spkiB64: string) {
    this.spkiB64 = spkiB64.trim();
  }

  configured(): boolean {
    return this.spkiB64.length > 0;
  }

  async verify(message: string, sig: number[]): Promise<boolean> {
    if (!this.configured()) {
      Log.w(LogEvents.REMOTE, 'event=verify result=rejected reason=no_public_key');
      return false;
    }
    try {
      const pub = await this.pubKey();
      if (pub === undefined) {
        return false;
      }
      ensureHashes();
      const ok = await ed.verifyAsync(new Uint8Array(sig), new Uint8Array(utf8Bytes(message)), pub, { zip215: false });
      if (!ok) {
        Log.w(LogEvents.REMOTE, 'event=verify result=bad_signature');
      }
      return ok;
    } catch (e) {
      Log.e(LogEvents.REMOTE, `event=verify result=error ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  private pubKey(): Promise<Uint8Array | undefined> {
    if (this.key === undefined) {
      this.key = this.loadKey();
    }
    return this.key;
  }

  private async loadKey(): Promise<Uint8Array | undefined> {
    const raw = rawKeyFromSpki(this.spkiB64);
    if (raw === undefined) {
      Log.e(LogEvents.REMOTE, 'event=verify result=bad_public_key code=-1 msg=not_an_ed25519_spki_key');
    }
    return raw;
  }
}
