// Suite: HomeRules.test - module under test: core/remote/HomeRules (Home = the city's walks, actions on the card).
// Cases: header from fix/bbox (inside, outside, no fix, bad bbox); which city Home lists; card actions for a walk
// not on the device / streaming / downloaded / running / preparing / failed / another tour running / no server;
// the Explore row's step (no walk yet, streamed walk, places on device, busy, no server) and which walk it activates.
import { describe, it, expect } from 'vitest';
import {
  CardActions, CardDownload, CardInput, cardActions, CardPrimary, ExploreInput, ExploreStep, exploreStep, ExploreWalk,
  exploreWalk, homeCity, HomeHeader, homeHeader
} from '../src';

const KRAKOW: number[] = [49.97, 19.79, 50.13, 20.22];

function input(): CardInput {
  const i = new CardInput();
  i.serverEnabled = true;
  return i;
}

function homeRulesTest() {
  describe('HomeRules', () => {
    it('header_in_city_when_fix_inside_bbox', () => {
      expect(homeHeader(50.0614, 19.9366, KRAKOW)).toBe(HomeHeader.IN_CITY);
    });
    it('header_walks_in_when_outside', () => {
      expect(homeHeader(39.9, 116.4, KRAKOW)).toBe(HomeHeader.WALKS_IN);   // the emulator's Beijing fix
    });
    it('header_walks_in_without_fix', () => {
      expect(homeHeader(Number.NaN, Number.NaN, KRAKOW)).toBe(HomeHeader.WALKS_IN);
    });
    it('header_walks_in_with_unknown_bbox', () => {
      expect(homeHeader(50.06, 19.93, [])).toBe(HomeHeader.WALKS_IN);
      expect(homeHeader(50.06, 19.93, [1, Number.NaN, 2, 3])).toBe(HomeHeader.WALKS_IN);
    });
    it('header_bbox_edge_is_inside', () => {
      expect(homeHeader(49.97, 19.79, KRAKOW)).toBe(HomeHeader.IN_CITY);
    });
    it('city_active_first_else_catalog_order', () => {
      expect(homeCity('krakow', ['warsaw', 'krakow'])).toBe('krakow');
      expect(homeCity('', ['warsaw', 'krakow'])).toBe('warsaw');
      expect(homeCity('gdansk', ['krakow'])).toBe('krakow');
      expect(homeCity('', [])).toBe('');
    });
    it('card_not_installed_starts_by_streaming', () => {
      const a: CardActions = cardActions(input());
      expect(a.primary).toBe(CardPrimary.START);
      expect(a.enabled).toBe(true);
      expect(a.demo).toBe(true);
      expect(a.download).toBe(CardDownload.DOWNLOAD);
      expect(a.canRemove).toBe(false);
      expect(a.confirmEnd).toBe(false);
    });
    it('card_streaming_offers_download_and_remove', () => {
      const i = input();
      i.streamed = true;
      const a = cardActions(i);
      expect(a.primary).toBe(CardPrimary.START);
      expect(a.download).toBe(CardDownload.DOWNLOAD);
      expect(a.canRemove).toBe(true);
    });
    it('card_downloaded_shows_done', () => {
      const i = input();
      i.downloaded = true;
      const a = cardActions(i);
      expect(a.download).toBe(CardDownload.DONE);
      expect(a.canRemove).toBe(true);
      i.updateAvailable = true;
      expect(cardActions(i).download).toBe(CardDownload.DOWNLOAD);
    });
    it('card_downloaded_offline_still_starts', () => {
      const i = new CardInput();
      i.downloaded = true;
      const a = cardActions(i);
      expect(a.primary).toBe(CardPrimary.START);
      expect(a.download).toBe(CardDownload.DONE);
    });
    it('card_not_on_device_without_server_unavailable', () => {
      const a = cardActions(new CardInput());
      expect(a.primary).toBe(CardPrimary.UNAVAILABLE);
      expect(a.enabled).toBe(false);
      expect(a.demo).toBe(false);
      expect(a.download).toBe(CardDownload.HIDDEN);
    });
    it('card_running_continues', () => {
      const i = input();
      i.streamed = true;
      i.active = true;
      i.activeHasDemo = true;
      i.running = true;
      const a = cardActions(i);
      expect(a.primary).toBe(CardPrimary.CONTINUE);
      expect(a.demo).toBe(false);
      expect(a.canRemove).toBe(false);
    });
    it('card_other_running_confirms_end', () => {
      const i = input();
      i.otherRunning = true;
      const a = cardActions(i);
      expect(a.primary).toBe(CardPrimary.START);
      expect(a.confirmEnd).toBe(true);
    });
    it('card_preparing_disabled', () => {
      const i = input();
      i.preparing = true;
      i.failed = true;
      const a = cardActions(i);
      expect(a.primary).toBe(CardPrimary.PREPARING);
      expect(a.enabled).toBe(false);
      expect(a.showFailed).toBe(false);
      expect(a.canRemove).toBe(false);
    });
    it('card_failed_shows_line', () => {
      const i = input();
      i.failed = true;
      const a = cardActions(i);
      expect(a.showFailed).toBe(true);
      expect(a.primary).toBe(CardPrimary.START);
    });
    it('card_downloading_shows_progress', () => {
      const i = input();
      i.streamed = true;
      i.downloading = true;
      const a = cardActions(i);
      expect(a.download).toBe(CardDownload.PROGRESS);
      expect(a.canRemove).toBe(false);
    });
    it('card_active_demo_follows_track', () => {
      const i = input();
      i.downloaded = true;
      i.active = true;
      expect(cardActions(i).demo).toBe(false);
      i.activeHasDemo = true;
      expect(cardActions(i).demo).toBe(true);
    });
    it('explore_offered_before_any_walk_is_loaded', () => {
      const i = new ExploreInput();
      i.homeCityId = 'krakow';
      i.serverEnabled = true;
      expect(exploreStep(i)).toBe(ExploreStep.PREPARE);   // fresh install: was hidden (the bug)
    });
    it('explore_hidden_without_city_or_walk', () => {
      const i = new ExploreInput();
      i.serverEnabled = true;
      expect(exploreStep(i)).toBe(ExploreStep.HIDDEN);
      i.homeCityId = 'krakow';
      i.serverEnabled = false;
      expect(exploreStep(i)).toBe(ExploreStep.HIDDEN);   // nothing loaded and nothing to fetch it from
    });
    it('explore_streamed_walk_fetches_the_places', () => {
      const i = new ExploreInput();
      i.homeCityId = 'krakow';
      i.activeLoaded = true;
      i.activeCityId = 'krakow';
      i.serverEnabled = true;
      expect(exploreStep(i)).toBe(ExploreStep.GET_PLACES);
      i.placesOnDevice = true;
      expect(exploreStep(i)).toBe(ExploreStep.OPEN);
    });
    it('explore_opens_offline_on_what_is_on_device', () => {
      const i = new ExploreInput();
      i.homeCityId = 'krakow';
      i.activeLoaded = true;
      i.activeCityId = 'krakow';
      expect(exploreStep(i)).toBe(ExploreStep.OPEN);
    });
    it('explore_self_contained_course_opens', () => {
      const i = new ExploreInput();
      i.activeLoaded = true;
      i.placesOnDevice = true;
      expect(exploreStep(i)).toBe(ExploreStep.OPEN);
    });
    it('explore_busy_shows_progress', () => {
      const i = new ExploreInput();
      i.homeCityId = 'krakow';
      i.serverEnabled = true;
      i.busy = true;
      expect(exploreStep(i)).toBe(ExploreStep.BUSY);
    });
    it('explore_other_city_loaded_prepares_home_city', () => {
      const i = new ExploreInput();
      i.homeCityId = 'krakow';
      i.activeLoaded = true;
      i.activeCityId = 'warsaw';
      i.placesOnDevice = true;
      i.serverEnabled = true;
      expect(exploreStep(i)).toBe(ExploreStep.PREPARE);
    });
    it('explore_walk_prefers_downloaded_then_streamed', () => {
      const a = new ExploreWalk('royal', 'krakow', false, false);
      const b = new ExploreWalk('kazimierz', 'krakow', false, true);
      const c = new ExploreWalk('scholars', 'krakow', true, false);
      const w = new ExploreWalk('old', 'warsaw', true, false);
      expect(exploreWalk([w, a, b, c], 'krakow')).toBe('scholars');
      expect(exploreWalk([w, a, b], 'krakow')).toBe('kazimierz');
      expect(exploreWalk([w, a], 'krakow')).toBe('royal');
      expect(exploreWalk([w], 'krakow')).toBe('');
      expect(exploreWalk([], '')).toBe('');
    });
  });
}

homeRulesTest();
