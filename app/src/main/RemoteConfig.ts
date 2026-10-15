/*
 * Build-time configuration of the OPTIONAL course / studio-voice server (docs/SERVER.md §3, §7). Public values only:
 * no secret ever goes here (the ElevenLabs key and the signing private key live on the server / maintainer machine).
 *
 * BASE_URL
 *   The public HTTPS origin of `server/` with no trailing slash, e.g. 'https://citytour.example'.
 *   An EMPTY string disables every remote feature: no network call is made, Home hides "More courses", the Courses
 *   screen says "Only the built-in course", the HUD shows "server disabled", and voice falls back exactly as before
 *   (bundled clips, then the built-in voice). The app is fully usable either way.
 *   The value below is a placeholder (the .example TLD never resolves): every call fails fast and the app shows the
 *   offline states. The lead sets the deployed URL at deploy time (SERVER.md §7 step 2).
 *
 * SIGNING_PUBLIC_KEY_SPKI_B64
 *   The Ed25519 PUBLIC key that signs catalog and course manifests, as base64 DER SubjectPublicKeyInfo (44 chars,
 *   starts with 'MCow'). Produce it from the publish CLI's key with:
 *     openssl pkey -in ed25519-private.pem -pubout -outform DER | base64
 *   or in Node: crypto.createPublicKey(pem).export({type:'spki',format:'der'}).toString('base64').
 *   While it is empty, every signed envelope is rejected (no unsigned catalog is ever trusted), so downloads are off
 *   but the cached / built-in courses and the runtime voice still work.
 *   The key below is the production key of the course server (`npm run keygen` in server/, SERVER.md §3.1); the
 *   committed server/seed/ envelopes verify with it (checked in Node, see RemoteEnvelope.test.ets).
 */
export class RemoteConfig {
  static readonly BASE_URL: string = 'https://citytour-server.onrender.com';

  static readonly SIGNING_PUBLIC_KEY_SPKI_B64: string = 'MCowBQYDK2VwAyEANFPeilKdvGie94ZqhSmM1XtF7YfHmKTobvQ1bla4g4w=';

  /** Network timeouts (ms). Every call also has an overall deadline (RemoteClient). */
  static readonly CONNECT_TIMEOUT_MS: number = 5000;
  static readonly READ_TIMEOUT_MS: number = 10000;
  static readonly JSON_DEADLINE_MS: number = 12000;
  static readonly BLOB_DEADLINE_MS: number = 60000;
  /** SERVER.md §2: the runtime voice budget per sentence. */
  static readonly TTS_BUDGET_MS: number = 2500;

  static enabled(): boolean {
    return RemoteConfig.BASE_URL.length > 0;
  }
}
