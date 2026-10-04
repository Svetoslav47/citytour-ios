// Suite: PackParser.test - module under test: core/content/PackParser (task B3, Person B).
// Runtime re-validation of the offline pack: bad records are dropped with a reason, bad files are blocking.
import { describe, it, expect } from 'vitest';
import { Lang, Maneuver, Poi } from '../src';
import {
  parseManifest, parseMap, parseNarrations, parsePois, parseRoutes, parseTours, pruneTourStops
} from '../src';
import {
  MANIFEST_OK, MANIFEST_V2, MAP_JSON, NARR_EN_JSON, POI_BARBICAN, POIS_JSON, ROUTES_JSON, TOURS_JSON
} from './fixtures/PackJson';

function packParserTest() {
  describe('PackParser', () => {
    it('manifest_ok', () => {
      const r = parseManifest(MANIFEST_OK);
      expect(r.error).toBe('');
      expect(r.manifest !== undefined && r.manifest.packId === 'krakow').toBe(true);
    });
    it('malformed_json_is_blocking', () => {
      expect(parseManifest('{ not json').error.length > 0).toBe(true);
      expect(parsePois('[{"id": ').error.length > 0).toBe(true);
      expect(parseRoutes('nope').error.length > 0).toBe(true);
    });
    it('other_schema_major_is_blocking', () => {
      expect(parseManifest(MANIFEST_V2).error.indexOf('schemaVersion') >= 0).toBe(true);
    });
    it('unknown_enum_and_bad_coords_are_dropped_with_reason', () => {
      const r = parsePois(POIS_JSON);
      expect(r.error).toBe('');
      expect(r.items.length).toBe(2);
      expect(r.drops.length).toBe(2);
      expect(r.drops[0].reason).toBe('enum_kind');
      expect(r.drops[0].id).toBe('poi_wd_Q1');
      expect(r.drops[1].reason).toBe('latlng');
    });
    it('valid_poi_fields_survive', () => {
      const p = parsePois(POIS_JSON).items[0];
      expect(p.id).toBe(POI_BARBICAN);
      expect(p.view !== undefined && p.view.look === 'up').toBe(true);
      expect(p.heritage !== undefined && p.heritage.unesco).toBe(true);
    });
    it('tour_stops_with_unknown_poi_are_pruned', () => {
      const pois = parsePois(POIS_JSON).items;
      const tours = parseTours(TOURS_JSON).items;
      expect(tours.length).toBe(1);
      const drops = pruneTourStops(tours, (id: string) => pois.some((p: Poi) => p.id === id));
      expect(tours[0].stops.length).toBe(2);
      expect(drops.length).toBe(1);
      expect(drops[0].reason).toBe('unknown_poi');
    });
    it('routes_matrix_and_legs', () => {
      const r = parseRoutes(ROUTES_JSON);
      expect(r.error).toBe('');
      expect(r.routes.nodeIds.length).toBe(2);
      expect(r.routes.legs.length).toBe(1);          // odd geometry leg dropped
      expect(r.drops[0].reason).toBe('geometry');
      expect(r.routes.legs[0].steps[0].maneuver).toBe(Maneuver.OTHER); // unknown maneuver kept as other
    });
    it('narrations_in_the_wrong_file_are_dropped', () => {
      const r = parseNarrations('narrations/en.json', NARR_EN_JSON, Lang.EN);
      expect(r.items.length).toBe(1);
      expect(r.drops[0].reason).toBe('wrong_file_lang');
    });
    it('map_drops_bad_features_and_layers', () => {
      const r = parseMap(MAP_JSON);
      expect(r.error).toBe('');
      expect(r.map !== undefined && r.map.layers.length === 1).toBe(true);
      expect(r.map !== undefined && r.map.layers[0].features.length === 1).toBe(true);
      expect(r.dropped).toBe(2);
    });
  });
}

packParserTest();
