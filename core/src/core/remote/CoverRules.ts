/*
 * Tour cover photo rules (docs/SERVER.md §3 `coverBlob` / `coverCredit`, data/ATTRIBUTION.md "Tour cover photos").
 * Pure: no @kit imports, unit-tested in entry/src/test/CoverRules.test.ets.
 *
 * Where a cover comes from, in order:
 *   1. the installed course: <pack>/cover.jpg with its credit <pack>/cover.json (signed with the course);
 *   2. the catalog: `coverBlob` (sha256) fetched from /v1/blobs/<sha>, verified and cached as filesDir/covers/<sha>.jpg,
 *      credited with the catalog's `coverCredit`;
 *   3. none: Home and Tour detail show the route map preview as before; a Courses row shows no banner.
 * A photo is never shown without its credit ("Photo: <author>, <licence>"), because the covers are CC BY-SA.
 */
import { SHA256_RE } from './ServerApi';

export const COVER_JPG: string = 'cover.jpg';
export const COVER_JSON: string = 'cover.json';
/** Cover files are 1280x800 JPEGs of at most 250 KB; anything much bigger is not a cover. */
export const MAX_COVER_BYTES: number = 512 * 1024;
/** The credit drawn on the photo stays one short line. */
export const MAX_AUTHOR_CHARS: number = 40;
const MAX_CREDIT_CHARS: number = 120;

export class CoverSubject {
  en: string = '';
  pl: string = '';
  zh: string = '';
}

/** cover.json of a pack (the full credit, for About & licences). */
export class CoverCredit {
  author: string = '';
  license: string = '';
  licenseUrl: string = '';
  sourceTitle: string = '';
  sourceUrl: string = '';
  publisher: string = '';
  changes: string = '';
  subject: CoverSubject = new CoverSubject();
}

function clean(v: Object | undefined, max: number): string {
  if (typeof v !== 'string') {
    return '';
  }
  const s = (v as string).replace(new RegExp('[\\u0000-\\u001f\\u007f]+', 'g'), ' ').replace(new RegExp('\\s+', 'g'), ' ')
    .trim();
  return s.length > max ? s.substring(0, max) : s;
}

function httpsUrl(v: Object | undefined): string {
  const s = clean(v, 300);
  return s.startsWith('https://') || s.startsWith('http://') ? s : '';
}

/** Parses cover.json; undefined unless it names at least an author and a licence. */
export function parseCoverJson(text: string): CoverCredit | undefined {
  let raw: Object | null = null;
  try {
    raw = JSON.parse(text) as Object;
  } catch (e) {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, Object>;
  const c = new CoverCredit();
  c.author = clean(r['author'], 80);
  c.license = clean(r['license'], 40);
  c.licenseUrl = httpsUrl(r['licenseUrl']);
  c.sourceTitle = clean(r['sourceTitle'], 200);
  c.sourceUrl = httpsUrl(r['sourceUrl']);
  c.publisher = clean(r['publisher'], 60);
  c.changes = clean(r['changes'], 200);
  const s: Object | undefined = r['subject'];
  if (s !== undefined && s !== null && typeof s === 'object' && !Array.isArray(s)) {
    const sr = s as Record<string, Object>;
    c.subject.en = clean(sr['en'], 160);
    c.subject.pl = clean(sr['pl'], 160);
    c.subject.zh = clean(sr['zh'], 160);
  }
  if (c.author === '' || c.license === '') {
    return undefined;
  }
  return c;
}

/** "<author>, <licence>" for the caption on the photo; a long author is shortened with an ellipsis. '' = no credit. */
export function creditText(author: string, license: string): string {
  let a = clean(author, 200);
  const l = clean(license, 40);
  if (a.length > MAX_AUTHOR_CHARS) {
    a = `${a.substring(0, MAX_AUTHOR_CHARS - 1).trim()}…`;
  }
  if (a === '' || l === '') {
    return '';
  }
  return `${a}, ${l}`;
}

/** The catalog's `coverCredit` ("<author>, <licence>"), cleaned; '' when missing or unusable. */
export function catalogCredit(v: string): string {
  const s = clean(v, MAX_CREDIT_CHARS);
  const i = s.lastIndexOf(',');
  if (i <= 0 || i >= s.length - 1) {
    return '';
  }
  return creditText(s.substring(0, i), s.substring(i + 1));
}

/** What the photo shows, in the text language (falls back to English); '' when unknown. Used as alt text. */
export function coverSubject(c: CoverCredit | undefined, lang: string): string {
  if (c === undefined) {
    return '';
  }
  const t = lang === 'pl' ? c.subject.pl : lang === 'zh' ? c.subject.zh : c.subject.en;
  return t !== '' ? t : c.subject.en;
}

/** filesDir/covers/<sha>.jpg file name of a catalog cover, '' for a bad sha. */
export function coverCacheName(sha: string): string {
  return SHA256_RE.test(sha) ? `${sha}.jpg` : '';
}

/** Where the cover of a screen comes from. */
export enum CoverSource { INSTALLED = 'installed', CATALOG = 'catalog', NONE = 'none' }

export class CoverChoice {
  source: CoverSource = CoverSource.NONE;
  /** Absolute path of the JPEG ('' = none: show the fallback). */
  path: string = '';
  /** "<author>, <licence>" ('' only with NONE). */
  credit: string = '';
}

/**
 * The cover to show: the installed course's own cover (with its cover.json credit) first, else the cached catalog
 * cover (with the catalog credit), else none. A photo without a credit is never chosen.
 */
export function chooseCover(installedPath: string, installedCredit: CoverCredit | undefined, cachedPath: string,
  catalogCreditLine: string): CoverChoice {
  const c = new CoverChoice();
  if (installedPath !== '' && installedCredit !== undefined) {
    const t = creditText(installedCredit.author, installedCredit.license);
    if (t !== '') {
      c.source = CoverSource.INSTALLED;
      c.path = installedPath;
      c.credit = t;
      return c;
    }
  }
  const cat = catalogCredit(catalogCreditLine);
  if (cachedPath !== '' && cat !== '') {
    c.source = CoverSource.CATALOG;
    c.path = cachedPath;
    c.credit = cat;
  }
  return c;
}

/** What a cover slot shows right now. */
export enum CoverView { LOADING = 'loading', PHOTO = 'photo', FALLBACK = 'fallback' }

/**
 * Home / Tour detail: a placeholder while the cover is being looked up (no map flash before the photo), the photo
 * when there is one, else the map preview (`FALLBACK`).
 */
export function coverView(loading: boolean, path: string): CoverView {
  if (path !== '') {
    return CoverView.PHOTO;
  }
  return loading ? CoverView.LOADING : CoverView.FALLBACK;
}

/** A catalog row expects a photo when the catalog names a cover (or the installed course has one). */
export function rowHasCover(coverBlob: string, installedPath: string): boolean {
  return SHA256_RE.test(coverBlob) || installedPath !== '';
}
