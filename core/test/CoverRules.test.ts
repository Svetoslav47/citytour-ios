// Suite: CoverRules.test - module under test: core/remote/CoverRules (tour cover photos, SERVER.md §3 coverBlob).
// Cases: cover.json parsing (complete credit, missing author/licence, junk); the credit line "<author>, <licence>"
// (long authors shortened, control characters removed); the catalog credit; alt text per language with English
// fallback; cache file names; the source order installed > catalog cache > none (never a photo without a credit);
// the Home / Tour detail slot (placeholder while loading, photo, map fallback); which Courses rows get a banner;
// the course version with a cover tag and the catalog's coverCredit.
import { describe, it, expect } from 'vitest';
import {
  catalogCredit, chooseCover, coverCacheName, CoverCredit, CoverSource, coverSubject, creditText, CoverView,
  coverView, parseCoverJson, rowHasCover
} from '../src';
import { courseVersion, parseCatalog } from '../src';

const SHA: string = 'ab'.repeat(32);

const COVER_JSON: string = '{"schemaVersion":1,"file":"cover.jpg","width":1280,"height":800,' +
  '"subject":{"en":"Wawel Royal Castle","pl":"Zamek na Wawelu","zh":""},"author":"Jakub Hałun",' +
  '"license":"CC BY-SA 4.0","licenseUrl":"https://creativecommons.org/licenses/by-sa/4.0",' +
  '"sourceTitle":"File:Wawel.jpg","sourceUrl":"https://commons.wikimedia.org/wiki/File:Wawel.jpg",' +
  '"publisher":"Wikimedia Commons","changes":"Cropped","retrievedAt":"2026-10-03T22:01:58Z"}';

function credit(author: string, license: string): CoverCredit {
  const c = new CoverCredit();
  c.author = author;
  c.license = license;
  return c;
}

function coverRulesTest() {
  describe('CoverRules', () => {
    it('parsesCoverJson', () => {
      const c = parseCoverJson(COVER_JSON) as CoverCredit;
      expect(c !== undefined).toBe(true);
      expect(c.author).toBe('Jakub Hałun');
      expect(c.license).toBe('CC BY-SA 4.0');
      expect(c.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0');
      expect(c.sourceUrl).toBe('https://commons.wikimedia.org/wiki/File:Wawel.jpg');
      expect(c.subject.pl).toBe('Zamek na Wawelu');
    });

    it('rejectsCoverJsonWithoutCredit', () => {
      expect(parseCoverJson('{"license":"CC BY-SA 4.0"}') === undefined).toBe(true);
      expect(parseCoverJson('{"author":"A"}') === undefined).toBe(true);
      expect(parseCoverJson('not json') === undefined).toBe(true);
      expect(parseCoverJson('[1,2]') === undefined).toBe(true);
      // a non-http licence URL is dropped, the credit stays
      const c = parseCoverJson('{"author":"A","license":"CC0 1.0","licenseUrl":"javascript:x"}') as CoverCredit;
      expect(c.licenseUrl).toBe('');
    });

    it('formatsCreditLine', () => {
      expect(creditText('Jakub Hałun', 'CC BY-SA 4.0')).toBe('Jakub Hałun, CC BY-SA 4.0');
      expect(creditText('  Chris \n Olszewski ', 'CC BY-SA 4.0')).toBe('Chris Olszewski, CC BY-SA 4.0');
      const long = creditText('A'.repeat(60), 'CC BY 4.0');
      expect(long).toBe(`${'A'.repeat(39)}…, CC BY 4.0`);
      expect(creditText('', 'CC BY 4.0')).toBe('');
      expect(creditText('A', '')).toBe('');
    });

    it('cleansCatalogCredit', () => {
      expect(catalogCredit('Marco Almbauer, CC BY-SA 4.0')).toBe('Marco Almbauer, CC BY-SA 4.0');
      expect(catalogCredit('Smith, J., CC BY 4.0')).toBe('Smith, J., CC BY 4.0');
      expect(catalogCredit('no licence')).toBe('');
      expect(catalogCredit('')).toBe('');
      expect(catalogCredit('Author,')).toBe('');
    });

    it('altTextPerLanguage', () => {
      const c = parseCoverJson(COVER_JSON) as CoverCredit;
      expect(coverSubject(c, 'pl')).toBe('Zamek na Wawelu');
      expect(coverSubject(c, 'en')).toBe('Wawel Royal Castle');
      expect(coverSubject(c, 'zh')).toBe('Wawel Royal Castle');   // missing zh falls back to English
      expect(coverSubject(undefined, 'en')).toBe('');
    });

    it('cacheNameOnlyForValidSha', () => {
      expect(coverCacheName(SHA)).toBe(`${SHA}.jpg`);
      expect(coverCacheName('../etc/passwd')).toBe('');
      expect(coverCacheName('AB'.repeat(32))).toBe('');
    });

    it('choosesInstalledThenCatalogThenNone', () => {
      const inst = chooseCover('/c/pack/cover.jpg', credit('A', 'CC BY 4.0'), '/c/covers/x.jpg', 'B, CC0 1.0');
      expect(inst.source).toBe(CoverSource.INSTALLED);
      expect(inst.path).toBe('/c/pack/cover.jpg');
      expect(inst.credit).toBe('A, CC BY 4.0');
      const cat = chooseCover('', undefined, '/c/covers/x.jpg', 'B, CC0 1.0');
      expect(cat.source).toBe(CoverSource.CATALOG);
      expect(cat.credit).toBe('B, CC0 1.0');
      const none = chooseCover('', undefined, '', 'B, CC0 1.0');
      expect(none.source).toBe(CoverSource.NONE);
      expect(none.path).toBe('');
    });

    it('neverAPhotoWithoutCredit', () => {
      // installed photo whose cover.json has no usable credit: falls through to the catalog, then to none
      expect(chooseCover('/p/cover.jpg', credit('', ''), '/c/x.jpg', 'B, CC0 1.0').source)
        .toBe(CoverSource.CATALOG);
      expect(chooseCover('/p/cover.jpg', undefined, '/c/x.jpg', '').source).toBe(CoverSource.NONE);
    });

    it('slotPlaceholderPhotoOrMap', () => {
      expect(coverView(true, '')).toBe(CoverView.LOADING);
      expect(coverView(false, '')).toBe(CoverView.FALLBACK);
      expect(coverView(true, '/p.jpg')).toBe(CoverView.PHOTO);
      expect(coverView(false, '/p.jpg')).toBe(CoverView.PHOTO);
    });

    it('rowBanner', () => {
      expect(rowHasCover(SHA, '')).toBe(true);
      expect(rowHasCover('', '/p/cover.jpg')).toBe(true);
      expect(rowHasCover('', '')).toBe(false);
      expect(rowHasCover('nothex', '')).toBe(false);
    });

    it('versionWithCoverTag', () => {
      const audio = '572a94e2' + 'f'.repeat(56);
      expect(courseVersion('2026.10.03-41e1482c', audio, '0123abcd')).toBe('2026.10.03-41e1482c-a572a94e2-c0123abcd');
      expect(courseVersion('2026.10.03-41e1482c', audio, 'bad')).toBe('2026.10.03-41e1482c-a572a94e2');
    });

    it('catalogCoverFields', () => {
      const payload = JSON.parse(`{"courses":[{"id":"krakow","version":"v1-c0123abcd","title":{"en":"The Royal Route"},` +
        `"coverBlob":"${SHA}","coverCredit":"Jakub Hałun, CC BY-SA 4.0"},` +
        `{"id":"krakow-scholars","version":"v1","coverCredit":"orphan credit, CC0 1.0"}]}`) as Object;
      const cat = parseCatalog(payload);
      expect(cat.courses.length).toBe(2);
      expect(cat.courses[0].coverBlob).toBe(SHA);
      expect(cat.courses[0].coverCredit).toBe('Jakub Hałun, CC BY-SA 4.0');
      // a credit without a cover is ignored
      expect(cat.courses[1].coverBlob).toBe('');
      expect(cat.courses[1].coverCredit).toBe('');
    });
  });
}

coverRulesTest();
