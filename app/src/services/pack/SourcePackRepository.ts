/*
 * A pack read through a PackSource (task B3): a course's own pack (data/course/<id>/tour/) or, with `placesOnly`, a
 * city places pack (data/city/<cityId>/), both downloaded from the course server; the app bundles no pack.
 * - load() runs once and is shared (the UI and the TourController both call it).
 * - Integrity: every file listed in manifest.json is checked for byte size and SHA-256 when it is read;
 *   a mismatch, invalid JSON or another schema major is blocking (PACK_ERR, ARCHITECTURE §9 row 17).
 * - Records are re-validated by core/content/PackParser; invalid ones are dropped (PACK_DROP).
 * - Narrations load lazily per language (NarrationRepository), the map lazily per level.
 * FilePackRepository supplies the bytes from filesDir/courses/<id>/<version>/ (docs/SERVER.md §6); tests can supply
 * any other PackSource.
 * iOS port: UTF-8 decode via FileStore.utf8Decode (TextDecoder when present); SHA-256 async via expo-crypto digest
 * (native), sync (lazy readers) via @noble/hashes sha256 (pure JS).
 */
import * as Crypto from 'expo-crypto';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { utf8Decode } from '../remote/FileStore';
import { AppIssue, IssueCode, IssueSeverity } from '@citytour/core';
import {
  Lang, LatLng, MapData, Narration, NarrationLength, PackFile, PackManifest, Persona, Poi, RouteData, SourceRef, Tour
} from '@citytour/core';
import { PackLoadResult, PackRepository } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import {
  emptyRoutes, parseManifest, parseMap, parsePersonas, parsePois, parseRoutes, parseSources, parseTours,
  pruneTourStops
} from '@citytour/core';
import { isStreamCityFile } from '@citytour/core';
import { NarrationRepository } from './NarrationRepository';

function hex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  }
  return s;
}

/** Where a pack's files come from (pack-relative paths such as 'pois.json', 'narrations/en.json'). Both throw on error. */
export interface PackSource {
  label(): string;
  read(file: string): Promise<Uint8Array>;
  readSync(file: string): Uint8Array;
}

export class SourcePackRepository implements PackRepository {
  private loading: Promise<PackLoadResult> | undefined = undefined;
  private readonly src: PackSource;
  private manifestData: PackManifest | undefined = undefined;
  private fileIndex: Map<string, PackFile> = new Map<string, PackFile>();
  private poiList: Poi[] = [];
  private poiById: Map<string, Poi> = new Map<string, Poi>();
  private tourList: Tour[] = [];
  private personaList: Persona[] = [];
  private sourceById: Map<string, SourceRef> = new Map<string, SourceRef>();
  private routeData: RouteData = emptyRoutes();
  private maps: Map<string, MapData> = new Map<string, MapData>();
  private narr: NarrationRepository;
  private prefetched: Map<string, string> = new Map<string, string>();
  /** A city places pack (data/city/<id>/): no tours.json, no routes, no personas (SERVER.md §3, R7). */
  private readonly placesOnly: boolean;
  /**
   * A STREAMED city (StreamRules): only manifest.json, city.json and the map are on the device. Its places, stories
   * and sources are not read (no places of its own: the course overlay holds the tour's stops and stories).
   */
  private readonly partial: boolean;

  constructor(src: PackSource, placesOnly: boolean = false, partial: boolean = false) {
    this.src = src;
    this.placesOnly = placesOnly;
    this.partial = placesOnly && partial;
    this.narr = new NarrationRepository((lang: Lang) => this.readTextSync(`narrations/${lang}.json`),
      (id: string) => this.poiById.get(id), (id: string) => this.sourceById.has(id));
  }

  load(): Promise<PackLoadResult> {
    if (this.loading === undefined) {
      this.loading = this.doLoad();
    }
    return this.loading;
  }

  pois(): Poi[] {
    return this.poiList;
  }

  /** The loaded pack manifest (undefined before a successful load). */
  manifest(): PackManifest | undefined {
    return this.manifestData;
  }

  /** The pack's own manifest lists `path` (e.g. 'map-detail.json', 'demo-walk.json'). */
  hasFile(path: string): boolean {
    return this.fileIndex.has(path);
  }

  /** A pack file as text, verified against the pack manifest (size + SHA-256); undefined when missing or bad. */
  readVerifiedText(path: string): Promise<string | undefined> {
    return this.fileIndex.has(path) ? this.readText(path, true) : Promise.resolve(undefined);
  }

  /** The persona fallback chain for this pack's narrations (a city pack has none of its own: the course's). */
  usePersonas(p: Persona[]): void {
    this.narr.setPersonas(p);
  }

  /** The city's own proper nouns for the narration check (city.json `properNouns`). */
  useCityNouns(nouns: string[]): void {
    this.narr.setCityNouns(nouns);
  }

  poi(id: string): Poi | undefined {
    return this.poiById.get(id);
  }

  tours(): Tour[] {
    return this.tourList;
  }

  personas(): Persona[] {
    return this.personaList;
  }

  routes(): RouteData {
    return this.routeData;
  }

  map(level: string): MapData {
    const hit = this.maps.get(level);
    if (hit !== undefined) {
      return hit;
    }
    const file = `map-${level}.json`;
    const text = this.readTextSync(file);
    let data: MapData | undefined = undefined;
    if (text !== undefined) {
      const r = parseMap(text);
      if (r.error !== '') {
        Log.e(LogEvents.PACK_ERR, `file=${file} reason=${r.error} blocking=false`);
      } else {
        data = r.map;
        if (r.dropped > 0) {
          Log.w(LogEvents.PACK_DROP, `file=${file} n=${r.dropped}`);
        }
      }
    }
    if (data === undefined) {
      const fallbackOrigin: LatLng = { lat: 0, lng: 0 };   // only before a successful load (nothing to draw)
      const origin = this.manifestData !== undefined ? this.manifestData.origin : fallbackOrigin;
      data = { level: level, origin: origin, bounds: [0, 0, 0, 0], layers: [] };
    }
    this.maps.set(level, data);
    return data;
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    try {
      return this.narr.get(poiId, personaId, lang, len);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SourcePackRepository.narration ${Log.errKv(e as Object)}`);
      return undefined;
    }
  }

  source(id: string): SourceRef | undefined {
    return this.sourceById.get(id);
  }

  // ---------- loading ----------

  private async doLoad(): Promise<PackLoadResult> {
    const t0 = Date.now();
    const issues: AppIssue[] = [];
    try {
      const mtext = await this.readText('manifest.json', false);
      if (mtext === undefined) {
        return this.fail(issues, 'manifest.json', 'missing');
      }
      const mr = parseManifest(mtext);
      if (mr.manifest === undefined) {
        return this.fail(issues, 'manifest.json', mr.error);
      }
      this.manifestData = mr.manifest;
      for (const f of mr.manifest.files) {
        this.fileIndex.set(f.path, f);
      }

      const ptext = this.partial ? '[]' : await this.readText('pois.json', true);
      if (ptext === undefined) {
        return this.fail(issues, 'pois.json', 'missing_or_integrity');
      }
      const pois = parsePois(ptext);
      if (pois.error !== '') {
        return this.fail(issues, 'pois.json', pois.error);
      }
      NarrationRepository.logDrops(pois.drops.length, pois.drops.length > 0 ? pois.drops[0].reason : '', 'pois.json');
      this.poiList = pois.items;
      this.poiById = new Map<string, Poi>();
      for (const p of pois.items) {
        this.poiById.set(p.id, p);
      }

      const ttext = this.placesOnly ? '[]' : await this.readText('tours.json', true);
      const tours = ttext === undefined ? undefined : parseTours(ttext);
      if (this.placesOnly) {
        this.tourList = [];
      } else if (tours === undefined || tours.error !== '' || tours.items.length === 0) {
        return this.fail(issues, 'tours.json', tours === undefined ? 'missing_or_integrity' : tours.error || 'empty');
      } else {
        const pruned = pruneTourStops(tours.items, (id: string) => this.poiById.has(id));
        NarrationRepository.logDrops(tours.drops.length + pruned.length,
          pruned.length > 0 ? pruned[0].reason : (tours.drops.length > 0 ? tours.drops[0].reason : ''), 'tours.json');
        this.tourList = tours.items.filter((t: Tour) => t.stops.length > 0);
      }

      const petext = this.placesOnly ? undefined : await this.readText('personas.json', true);
      const personas = petext === undefined ? undefined : parsePersonas(petext);
      this.personaList = personas === undefined ? [] : personas.items;
      this.narr.setPersonas(this.personaList);

      const stext = this.partial ? undefined : await this.readText('sources.json', true);
      const sources = stext === undefined ? undefined : parseSources(stext);
      this.sourceById = new Map<string, SourceRef>();
      if (sources !== undefined) {
        for (const s of sources.items) {
          this.sourceById.set(s.id, s);
        }
        NarrationRepository.logDrops(sources.drops.length, sources.drops.length > 0 ? sources.drops[0].reason : '',
          'sources.json');
      }

      const rtext = this.placesOnly ? undefined : await this.readText('routes.json', true);
      const routes = rtext === undefined ? undefined : parseRoutes(rtext);
      if (this.placesOnly) {
        this.routeData = emptyRoutes();
      } else if (routes === undefined || routes.error !== '') {
        // Not blocking: the planner falls back to straight-line estimates (§9 rows 19-20).
        Log.w(LogEvents.ROUTE_FALLBACK, `file=routes.json reason=${routes === undefined ? 'missing' : routes.error}`);
        issues.push({ code: IssueCode.ROUTE_FALLBACK, severity: IssueSeverity.WARN, detail: 'routes.json' });
        this.routeData = emptyRoutes();
      } else {
        this.routeData = routes.routes;
        NarrationRepository.logDrops(routes.drops.length, routes.drops.length > 0 ? routes.drops[0].reason : '',
          'routes.json');
      }

      const prefetched = await this.prefetchLazyFiles(mr.manifest.files);
      const narrEn = this.narr.ensure(Lang.EN);
      Log.i(LogEvents.PACK_LOAD, `where=repo src=${this.src.label()} ms=${Date.now() - t0} pack=${mr.manifest.packId} ` +
        `version=${mr.manifest.version} pois=${this.poiList.length} tours=${this.tourList.length} ` +
        `narr=${narrEn} prefetched=${prefetched} legs=${this.routeData.legs.length} sources=${this.sourceById.size}`);
      const ok: PackLoadResult = { ok: true, manifest: mr.manifest, issues: issues };
      return ok;
    } catch (e) {
      return this.fail(issues, 'pack', `exception ${Log.errKv(e as Object)}`);
    }
  }

  private fail(issues: AppIssue[], file: string, reason: string): PackLoadResult {
    Log.e(LogEvents.PACK_ERR, `file=${file} reason=${reason} blocking=true`);
    issues.push({ code: IssueCode.PACK_ERR, severity: IssueSeverity.BLOCKING, detail: `${file}: ${reason}` });
    const r: PackLoadResult = { ok: false, issues: issues };
    return r;
  }

  /**
   * Reads a pack file; when `verify`, checks it against the manifest (bytes + SHA-256). The read and the hash are
   * asynchronous (expo-file-system / expo-crypto Promises), so the JS thread only decodes and parses.
   */
  private async readText(file: string, verify: boolean): Promise<string | undefined> {
    try {
      const bytes = await this.src.read(file);
      if (verify && !this.checkEntry(file, bytes, await this.sha256Async(bytes))) {
        return undefined;
      }
      return SourcePackRepository.decode(bytes);
    } catch (e) {
      Log.e(LogEvents.PACK_ERR, `file=${file} reason=read ${Log.errKv(e as Object)}`);
      return undefined;
    }
  }

  /** Narrations and maps are read during load() (async) and handed out once to the lazy synchronous readers. */
  private async prefetchLazyFiles(files: PackFile[]): Promise<number> {
    let n = 0;
    for (const f of files) {
      if ((f.path.startsWith('narrations/') || f.path.startsWith('map-')) && (!this.partial || isStreamCityFile(f.path))) {
        const t = await this.readText(f.path, true);
        if (t !== undefined) {
          this.prefetched.set(f.path, t);
          n++;
        }
      }
    }
    return n;
  }

  private readTextSync(file: string): string | undefined {
    if (this.partial && !isStreamCityFile(file)) {
      return undefined;   // not on the device for a streamed city (no places of its own)
    }
    const hit = this.prefetched.get(file);
    if (hit !== undefined) {
      this.prefetched.delete(file);   // parsed once by its reader, which keeps the result
      return hit;
    }
    try {
      const bytes = this.src.readSync(file);
      return this.checkEntry(file, bytes, this.sha256(bytes)) ? SourcePackRepository.decode(bytes) : undefined;
    } catch (e) {
      Log.w(LogEvents.PACK_ERR, `file=${file} reason=read ${Log.errKv(e as Object)} blocking=false`);
      return undefined;
    }
  }

  private static decode(bytes: Uint8Array): string {
    return utf8Decode(bytes);
  }

  /** Size + SHA-256 against the pack manifest. `sha` '' = crypto unavailable (size check only). */
  private checkEntry(file: string, bytes: Uint8Array, sha: string): boolean {
    const entry = this.fileIndex.get(file);
    if (entry === undefined) {
      Log.w(LogEvents.PACK_ERR, `file=${file} reason=not_in_manifest blocking=false`);
      return true;
    }
    if (entry.bytes !== bytes.length) {
      Log.e(LogEvents.PACK_ERR, `file=${file} reason=size expected=${entry.bytes} got=${bytes.length}`);
      return false;
    }
    if (sha !== '' && entry.sha256 !== '' && sha !== entry.sha256.toLowerCase()) {
      Log.e(LogEvents.PACK_ERR, `file=${file} reason=sha256_mismatch`);
      return false;
    }
    return true;
  }

  /** Async hex SHA-256 (native digest), or '' if the crypto service is unavailable. */
  private async sha256Async(bytes: Uint8Array): Promise<string> {
    try {
      const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
      const d = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data as Uint8Array<ArrayBuffer>);
      return hex(new Uint8Array(d));
    } catch (e) {
      Log.w(LogEvents.PACK_ERR, `reason=sha256_unavailable ${Log.errKv(e as Object)} blocking=false`);
      return '';
    }
  }

  /** Hex SHA-256, or '' if the crypto service is unavailable (then only the size check applies). */
  private sha256(bytes: Uint8Array): string {
    try {
      return hex(nobleSha256(bytes));
    } catch (e) {
      Log.w(LogEvents.PACK_ERR, `reason=sha256_unavailable ${Log.errKv(e as Object)} blocking=false`);
      return '';
    }
  }
}
