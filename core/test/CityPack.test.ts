// Suite: CityPack.test - module under test: core/content/CityPack (city places packs, SERVER.md §3 R7).
// Cases: city.json parsing (valid, missing origin/id/names, bad boxes, proper nouns incl. the city's own name); the
// city's display name per UI language with fallbacks (no inflection: the nominative goes into the string slot);
// lat/lng box -> world box in the pack projection; layering course records over city records (course wins, order
// kept, course-only records appended); the layered manifest (origin mismatch refused, city bbox, place count,
// licences without duplicates, files of both); the media session album line.
import { describe, it, expect } from 'vitest';
import { PackFile, PackManifest, Poi } from '../src';
import {
  albumLine, cityDisplayName, CityInfo, latLngBox, layerManifests, layerPois, parseCityJson, worldBox
} from '../src';
import { Projection } from '../src';

const CITY_JSON: string = '{"schemaVersion":1,"cityId":"krakow","names":{"en":"Kraków","pl":"Kraków","zh":"克拉科夫"},' +
  '"origin":{"lat":50.06143,"lng":19.93658},"bbox":[49.978575,19.796944,50.1278,20.202296],' +
  '"defaultBounds":[50.0525,19.929,50.0675,19.947],"properNouns":["Vistula","Wawel"," ",""]}';

function poi(id: string, name: string): Poi {
  const p: Poi = {
    id: id, kind: 'other', lat: 50, lng: 19, x: 0, y: 0, names: { en: name }, importance: 0, tier: 'name-only',
    triggerRadiusM: 30, sourceIds: []
  } as Poi;
  return p;
}

function manifest(packId: string, lat: number, lng: number, files: string[], licenses: string[]): PackManifest {
  const m: PackManifest = {
    schemaVersion: 1, packId: packId, version: `${packId}-v`, builtAt: '2026-10-03T00:00:00Z', origin: { lat: lat, lng: lng },
    bbox: [1, 2, 3, 4], files: files.map((f: string) => {
      const pf: PackFile = { path: f, bytes: 10, sha256: '' };
      return pf;
    }),
    counts: { pois: 0, narrations_en: 5, narrations_pl: 6, narrations_zh: 7, legs: 8 }, licenses: licenses
  };
  return m;
}

function cityPackTest() {
  describe('CityPack', () => {
    it('parsesCityJson', () => {
      const c = parseCityJson(CITY_JSON) as CityInfo;
      expect(c !== undefined).toBe(true);
      expect(c.id).toBe('krakow');
      expect(c.names.zh).toBe('克拉科夫');
      expect(c.origin.lat).toBe(50.06143);
      expect(c.bbox.length).toBe(4);
      expect(c.defaultBounds[1]).toBe(19.929);
      // blank nouns dropped; the city's own name is always grounded (once)
      expect(c.properNouns.join('|')).toBe('Vistula|Wawel|Kraków');
    });

    it('rejectsUnusableCityJson', () => {
      expect(parseCityJson('not json') === undefined).toBe(true);
      expect(parseCityJson('[]') === undefined).toBe(true);
      expect(parseCityJson('{"cityId":"x","names":{"en":"X"}}') === undefined).toBe(true);                 // no origin
      expect(parseCityJson('{"cityId":"x","names":{"en":"X"},"origin":{"lat":91,"lng":0}}') === undefined).toBe(true);
      expect(parseCityJson('{"cityId":"","names":{"en":"X"},"origin":{"lat":1,"lng":2}}') === undefined).toBe(true);
      expect(parseCityJson('{"cityId":"x","names":{},"origin":{"lat":1,"lng":2}}') === undefined).toBe(true);
      // optional parts missing or malformed: still a city, with empty boxes
      const c = parseCityJson('{"cityId":"gdansk","names":{"pl":"Gdańsk"},"origin":{"lat":54.35,"lng":18.65},' +
        '"bbox":[1,2],"defaultBounds":[5,5,4,6]}') as CityInfo;
      expect(c.id).toBe('gdansk');
      expect(c.bbox.length).toBe(0);
      expect(c.defaultBounds.length).toBe(0);
    });

    it('latLngBoxValidation', () => {
      expect(latLngBox([1, 2, 3, 4]).length).toBe(4);
      expect(latLngBox([3, 2, 1, 4]).length).toBe(0);     // min >= max
      expect(latLngBox([1, 2, 3]).length).toBe(0);
      expect(latLngBox([1, 200, 3, 201]).length).toBe(0);
      expect(latLngBox(undefined).length).toBe(0);
    });

    it('cityNamePerUiLanguage', () => {
      const c = parseCityJson(CITY_JSON) as CityInfo;
      expect(cityDisplayName(c, 'en', '')).toBe('Kraków');
      expect(cityDisplayName(c, 'pl', '')).toBe('Kraków');   // nominative: "Wszystkie miejsca: Kraków"
      expect(cityDisplayName(c, 'zh', '')).toBe('克拉科夫');
      const g = parseCityJson('{"cityId":"gdansk","names":{"pl":"Gdańsk"},"origin":{"lat":54.35,"lng":18.65}}');
      expect(cityDisplayName(g, 'en', 'x')).toBe('Gdańsk');  // any name before the fallback
      expect(cityDisplayName(undefined, 'en', 'Kraków')).toBe('Kraków');   // older course: catalog `city`
      expect(cityDisplayName(undefined, 'zh', '')).toBe('');
    });

    it('worldBoxInPackProjection', () => {
      const p = new Projection(50.06143, 19.93658);
      const b = worldBox([50.0525, 19.929, 50.0675, 19.947], p);
      expect(b.length).toBe(4);
      expect(Math.abs(b[0] - p.x(19.929)) < 1e-9).toBe(true);
      expect(Math.abs(b[1] - p.y(50.0525)) < 1e-9).toBe(true);
      expect(b[2] > b[0] && b[3] > b[1]).toBe(true);
      expect(worldBox([], p).length).toBe(0);
      // another city, another origin: its own frame (the box is around 0,0 of its origin)
      const g = new Projection(54.35, 18.65);
      const gb = worldBox([54.34, 18.64, 54.36, 18.66], g);
      expect(gb[0] < 0 && gb[2] > 0 && gb[1] < 0 && gb[3] > 0).toBe(true);
    });

    it('layersCourseOverCity', () => {
      const city = [poi('a', 'A city'), poi('b', 'B city'), poi('c', 'C city')];
      const course = [poi('b', 'B curated'), poi('z', 'Z course only')];
      const out = layerPois(city, course);
      expect(out.map((p: Poi) => `${p.id}:${p.names.en}`).join(',')).toBe('a:A city,b:B curated,c:C city,z:Z course only');
      expect(layerPois([], course).length).toBe(2);
      expect(layerPois(city, []).length).toBe(3);
    });

    it('layeredManifest', () => {
      const city = manifest('krakow', 50.06143, 19.93658, ['pois.json', 'city.json'], ['OSM', 'Wikipedia']);
      city.bbox = [49.9, 19.7, 50.2, 20.3];
      const course = manifest('krakow-scholars', 50.06143, 19.93658, ['tours.json'], ['OSRM', 'OSM']);
      const r = layerManifests(city, course, 4291);
      expect(r.error).toBe('');
      const m = r.manifest as PackManifest;
      expect(m.packId).toBe('krakow-scholars');
      expect(m.version).toBe('krakow-scholars-v');
      expect(m.bbox[0]).toBe(49.9);                        // the out-of-area check uses the city bbox
      expect(m.counts.pois).toBe(4291);
      expect(m.counts.legs).toBe(8);
      expect(m.licenses.join('|')).toBe('OSRM|OSM|Wikipedia');
      expect(m.files.map((f: PackFile) => f.path).join(',')).toBe('tours.json,city/pois.json,city/city.json');
      const bad = layerManifests(city, manifest('x', 54.35, 18.65, [], []), 1);
      expect(bad.error).toBe('origin_mismatch');
      expect(bad.manifest === undefined).toBe(true);
    });

    it('albumLine', () => {
      expect(albumLine('Kraków', 'The Royal Route')).toBe('Kraków · The Royal Route');
      expect(albumLine('', 'The Royal Route')).toBe('The Royal Route');
      expect(albumLine('Gdańsk', ' ')).toBe('Gdańsk');
      expect(albumLine('', '')).toBe('CityTour');
    });
  });
}

cityPackTest();
