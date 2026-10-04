/*
 * HTTP client of the optional CityTour server (docs/SERVER.md §3, API v1). HarmonyOS used Network Kit `http`; the iOS
 * port uses React Native's fetch + AbortController (connect/read timeouts emulated per phase, see call()).
 *
 * - Every call has connect/read timeouts AND an overall deadline timer that aborts the request, so nothing waits
 *   longer than its budget (TTS: 2.5 s). Every call resolves (never rejects): status 0 = no HTTP response.
 * - Signed envelopes (catalog, manifest) are verified with Ed25519 before they are returned (fail closed).
 * - Install token (POST /v1/installs): persisted with its expiry in filesDir/remote/install.json, refreshed a day
 *   before it expires, and once more after a 401 from /v1/tts. It is a throttle key only and is never logged.
 * - BASE_URL '' (RemoteConfig) = disabled: no request is ever made.
 * Logs: REMOTE path=... status=... ms=... (no token, no text).
 */
import { RemoteConfig } from '../../app/RemoteConfig';
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';
import {
  CatalogParse, CitySummary, CourseManifest, CourseSummary, InstallToken, parseCatalog, parseCityManifest,
  parseCourseManifest, parseEnvelope,
  parseInstall, SHA256_RE, tokenUsable, ttsBodyJson, utf8Bytes
} from '@citytour/core';
import { RemoteResult } from '@citytour/core';
import { FileStore } from './FileStore';
import { SignatureVerifier } from './SignatureVerifier';

export class HttpOutcome {
  status: number = 0;            // 0 = no response (offline, DNS, TLS, deadline)
  timedOut: boolean = false;
  text: string = '';
  bytes: ArrayBuffer | undefined = undefined;
  headers: Record<string, string> = {};
  ms: number = 0;
  error: string = '';
}

export class SignedResult {
  ok: boolean = false;
  status: number = 0;
  error: string = '';
  /** The raw envelope text (kept as the offline copy of the catalog). */
  text: string = '';
}

export class CatalogResult extends SignedResult {
  courses: CourseSummary[] = [];
  cities: CitySummary[] = [];
}

export class ManifestResult extends SignedResult {
  manifest: CourseManifest | undefined = undefined;
}

export class TtsResult {
  result: RemoteResult = new RemoteResult();
  audio: ArrayBuffer | undefined = undefined;
  cacheHeader: string = '';
}

/** What a call reads the body as (Network Kit http.HttpDataType STRING / ARRAY_BUFFER). */
enum HttpDataType {
  STRING = 0,
  ARRAY_BUFFER = 1
}

function utf8Len(s: string): number {
  return utf8Bytes(s).length;
}

function headerOf(h: Headers | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (h === undefined || h === null) {
    return out;
  }
  try {
    h.forEach((v: string, k: string) => {
      out[k.toLowerCase()] = v === undefined || v === null ? '' : String(v);
    });
  } catch (e) {
    // headers unreadable: callers treat missing headers as a failure where it matters (X-Text-Sha256)
  }
  return out;
}

export class RemoteClient {
  private readonly base: string;
  private readonly verifier: SignatureVerifier;
  private readonly dirOf: () => string;
  private token: InstallToken | undefined = undefined;
  private tokenLoaded: boolean = false;
  private tokenReq: Promise<string> | undefined = undefined;

  /** dirOf: the app's filesDir ('' before the context exists). */
  constructor(base: string, verifier: SignatureVerifier, dirOf: () => string) {
    this.base = base.endsWith('/') ? base.substring(0, base.length - 1) : base;
    this.verifier = verifier;
    this.dirOf = dirOf;
  }

  enabled(): boolean {
    return this.base.length > 0;
  }

  /** Signatures can be checked (a public key is configured). */
  canVerify(): boolean {
    return this.verifier.configured();
  }

  /** GET /healthz within 3 s: true when the server answers 200. */
  async health(): Promise<boolean> {
    if (!this.enabled()) {
      return false;
    }
    const h = await this.call('GET', '/healthz', '', HttpDataType.STRING, 3000, {});
    return h.status === 200;
  }

  // ---------- signed JSON ----------

  async catalog(): Promise<CatalogResult> {
    const r = new CatalogResult();
    if (!this.enabled()) {
      r.error = 'disabled';
      return r;
    }
    const h = await this.call('GET', '/v1/catalog', '', HttpDataType.STRING, RemoteConfig.JSON_DEADLINE_MS, {});
    r.status = h.status;
    if (h.status !== 200) {
      r.error = h.status === 0 ? `offline ${h.error}` : `http_${h.status}`;
      return r;
    }
    return this.acceptCatalog(h.text);
  }

  /** Verifies and parses an envelope text (fresh from the server or the cached copy). */
  async acceptCatalog(text: string): Promise<CatalogResult> {
    const r = new CatalogResult();
    r.status = 200;
    const env = parseEnvelope(text);
    if (env.error !== '') {
      r.error = `envelope_${env.error}`;
      return r;
    }
    if (!(await this.verifier.verify(env.canonical, env.sig))) {
      r.error = this.verifier.configured() ? 'bad_signature' : 'no_public_key';
      return r;
    }
    const cat: CatalogParse = parseCatalog(env.payload);
    if (cat.error !== '') {
      r.error = `catalog_${cat.error}`;
      return r;
    }
    r.ok = true;
    r.courses = cat.courses;
    r.cities = cat.cities;
    r.text = text;
    Log.i(LogEvents.COURSE, `event=catalog_ok courses=${cat.courses.length} cities=${cat.cities.length} dropped=${cat.dropped}`);
    return r;
  }

  manifest(courseId: string): Promise<ManifestResult> {
    return this.signedManifest(courseId, false);
  }

  /** GET /v1/cities/:cityId/manifest: a city's places pack (SERVER.md §3, R7), verified like a course manifest. */
  cityManifest(cityId: string): Promise<ManifestResult> {
    return this.signedManifest(cityId, true);
  }

  private async signedManifest(id: string, city: boolean): Promise<ManifestResult> {
    const r = new ManifestResult();
    if (!this.enabled()) {
      r.error = 'disabled';
      return r;
    }
    const h = await this.call('GET', `/v1/${city ? 'cities' : 'courses'}/${encodeURIComponent(id)}/manifest`, '',
      HttpDataType.STRING, RemoteConfig.JSON_DEADLINE_MS, {});
    r.status = h.status;
    if (h.status !== 200) {
      r.error = h.status === 0 ? `offline ${h.error}` : `http_${h.status}`;
      return r;
    }
    const env = parseEnvelope(h.text);
    if (env.error !== '') {
      r.error = `envelope_${env.error}`;
      return r;
    }
    if (!(await this.verifier.verify(env.canonical, env.sig))) {
      r.error = this.verifier.configured() ? 'bad_signature' : 'no_public_key';
      return r;
    }
    const m = city ? parseCityManifest(env.payload, id) : parseCourseManifest(env.payload, id);
    if (m.manifest === undefined) {
      r.error = `manifest_${m.error}`;
      return r;
    }
    r.ok = true;
    r.manifest = m.manifest;
    r.text = h.text;
    return r;
  }

  /** GET /v1/blobs/:sha256 (bytes, unverified: the caller checks the sha). */
  async blob(sha: string, deadlineMs: number = RemoteConfig.BLOB_DEADLINE_MS): Promise<HttpOutcome> {
    if (!this.enabled() || !SHA256_RE.test(sha)) {
      const o = new HttpOutcome();
      o.error = 'disabled_or_bad_sha';
      return o;
    }
    return this.call('GET', `/v1/blobs/${sha}`, '', HttpDataType.ARRAY_BUFFER, deadlineMs, {});
  }

  // ---------- runtime voice ----------

  /** POST /v1/tts within `budgetMs` (token fetch included). Never rejects. */
  async tts(courseId: string, lang: string, text: string, budgetMs: number): Promise<TtsResult> {
    const out = new TtsResult();
    const t0 = Date.now();
    if (!this.enabled()) {
      return out;
    }
    const body = ttsBodyJson(courseId, lang, text, utf8Len);
    if (body === '') {
      out.result.status = 400;
      return out;
    }
    const token = await this.installToken(budgetMs);
    const left = budgetMs - (Date.now() - t0);
    if (token === '' || left <= 50) {
      out.result.timedOut = left <= 50;
      out.result.elapsedMs = Date.now() - t0;
      return out;
    }
    let h = await this.call('POST', '/v1/tts', body, HttpDataType.ARRAY_BUFFER, left,
      { 'Authorization': `Bearer ${token}` });
    if (h.status === 401) {
      // the token was revoked or the server's secret rotated: one fresh token, if the budget allows
      this.forgetToken();
      const t2 = await this.installToken(budgetMs - (Date.now() - t0));
      const left2 = budgetMs - (Date.now() - t0);
      if (t2 !== '' && left2 > 50) {
        h = await this.call('POST', '/v1/tts', body, HttpDataType.ARRAY_BUFFER, left2,
          { 'Authorization': `Bearer ${t2}` });
      }
    }
    out.result.status = h.status;
    out.result.timedOut = h.timedOut;
    out.result.elapsedMs = Date.now() - t0;
    out.result.headerSha = h.headers['x-text-sha256'] ?? '';
    out.result.contentType = h.headers['content-type'] ?? '';
    out.result.bytes = h.bytes !== undefined ? h.bytes.byteLength : 0;
    out.cacheHeader = h.headers['x-cache'] ?? '';
    out.audio = h.bytes;
    return out;
  }

  /** A usable install token ('' when the server cannot be reached within `budgetMs`). */
  async installToken(budgetMs: number): Promise<string> {
    await this.loadToken();
    if (tokenUsable(this.token, Date.now())) {
      return (this.token as InstallToken).token;
    }
    if (this.tokenReq === undefined) {
      this.tokenReq = this.fetchToken().finally(() => {
        this.tokenReq = undefined;
      });
    }
    const req: Promise<string> = this.tokenReq;
    const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(''), Math.max(0, budgetMs)));
    return Promise.race([req, timeout]);
  }

  private async fetchToken(): Promise<string> {
    const h = await this.call('POST', '/v1/installs', '{}', HttpDataType.STRING, RemoteConfig.JSON_DEADLINE_MS,
      {});
    if (h.status !== 200 && h.status !== 201) {   // the server answers 201 Created
      Log.w(LogEvents.REMOTE, `event=install_fail status=${h.status} ${h.error}`);
      return '';
    }
    const t = parseInstall(h.text);
    if (t === undefined) {
      Log.w(LogEvents.REMOTE, 'event=install_fail reason=malformed');
      return '';
    }
    this.token = t;
    await this.saveToken(t);
    Log.i(LogEvents.REMOTE, `event=install_ok expires=${new Date(t.expiresAtMs).toISOString()}`);
    return t.token;
  }

  private forgetToken(): void {
    this.token = undefined;
    const p = this.tokenPath();
    if (p !== '') {
      FileStore.remove(p);
    }
  }

  private tokenPath(): string {
    const d = this.dirOf();
    return d === '' ? '' : `${d}/remote/install.json`;
  }

  private async loadToken(): Promise<void> {
    if (this.tokenLoaded) {
      return;
    }
    this.tokenLoaded = true;
    const p = this.tokenPath();
    if (p === '') {
      return;
    }
    const text = await FileStore.readText(p);
    if (text === undefined) {
      return;
    }
    let raw: Object | null = null;
    try {
      raw = JSON.parse(text) as Object;
    } catch (e) {
      return;
    }
    const rec = raw as Record<string, Object>;
    const t = new InstallToken();
    t.token = typeof rec['token'] === 'string' ? rec['token'] as string : '';
    t.expiresAtMs = typeof rec['expiresAtMs'] === 'number' ? rec['expiresAtMs'] as number : 0;
    if (t.token !== '') {
      this.token = t;
    }
  }

  private async saveToken(t: InstallToken): Promise<void> {
    const p = this.tokenPath();
    if (p !== '') {
      await FileStore.writeText(p, JSON.stringify(t));
    }
  }

  // ---------- transport ----------

  /**
   * One request over fetch + AbortController. Network Kit had separate connect and read timeouts; fetch has neither,
   * so they are emulated: until the response headers arrive the request is aborted after
   * min(CONNECT_TIMEOUT_MS, deadline) ("connect"), then the body must arrive within min(READ_TIMEOUT_MS, deadline)
   * ("read"); the overall deadline timer still bounds the whole call. Never rejects.
   */
  private call(method: string, path: string, body: string, type: HttpDataType, deadlineMs: number,
    extraHeaders: Record<string, string>): Promise<HttpOutcome> {
    const t0 = Date.now();
    return new Promise<HttpOutcome>((resolve) => {
      const out = new HttpOutcome();
      let settled = false;
      const ctrl = new AbortController();
      let phaseTimer: ReturnType<typeof setTimeout> | undefined = undefined;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (phaseTimer !== undefined) {
          clearTimeout(phaseTimer);
        }
        out.ms = Date.now() - t0;
        try {
          ctrl.abort();
        } catch (e) {
          // already finished
        }
        Log.i(LogEvents.REMOTE, `method=${method} path=${path.startsWith('/v1/blobs/') ? path.substring(0, 22) : path}` +
          ` status=${out.status} ms=${out.ms}${out.timedOut ? ' timeout=1' : ''}${out.error !== '' ? ` err=${out.error}` : ''}`);
        resolve(out);
      };
      const timer = setTimeout(() => {
        out.timedOut = true;
        out.status = 0;
        out.error = `deadline_${deadlineMs}ms`;
        finish();
      }, Math.max(1, deadlineMs));
      const phase = (name: string, ms: number) => {
        if (phaseTimer !== undefined) {
          clearTimeout(phaseTimer);
        }
        phaseTimer = setTimeout(() => {
          out.timedOut = true;
          out.status = 0;
          out.error = `${name}_timeout_${ms}ms`;
          finish();
        }, ms);
      };
      const run = async (): Promise<void> => {
        const header: Record<string, string> = { 'Accept': type === HttpDataType.STRING ? 'application/json' : '*/*' };
        if (method === 'POST') {
          header['Content-Type'] = 'application/json';
        }
        for (const k of Object.keys(extraHeaders)) {
          header[k] = extraHeaders[k];
        }
        const init: RequestInit = {
          method: method === 'POST' ? 'POST' : 'GET',
          headers: header,
          cache: 'no-store',
          signal: ctrl.signal
        };
        if (method === 'POST') {
          init.body = body;
        }
        phase('connect', Math.min(RemoteConfig.CONNECT_TIMEOUT_MS, Math.max(1, deadlineMs)));
        const resp = await fetch(`${this.base}${path}`, init);
        if (settled) {
          return;
        }
        phase('read', Math.min(RemoteConfig.READ_TIMEOUT_MS, Math.max(1, deadlineMs)));
        const status = typeof resp.status === 'number' ? resp.status : 0;
        const headers = headerOf(resp.headers);
        let bytes: ArrayBuffer | undefined = undefined;
        let text = '';
        if (type === HttpDataType.ARRAY_BUFFER) {
          bytes = await resp.arrayBuffer();
        } else {
          text = await resp.text();
        }
        if (settled) {
          return;
        }
        out.status = status;
        out.headers = headers;
        out.bytes = bytes;
        out.text = text;
        finish();
      };
      run().catch((e: Object) => {
        if (settled) {
          return;
        }
        out.status = 0;
        out.error = Log.errKv(e).replace(/ /g, '_');
        finish();
      });
    });
  }
}
