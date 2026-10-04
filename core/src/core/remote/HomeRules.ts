/*
 * Home = the walks of the current city (docs/SERVER.md §6 "Home"). Pure: no @kit imports, unit-tested in
 * entry/src/test/HomeRules.test.ets.
 *
 * - Header: "You're in {city}" when the latest location fix lies inside that city's bbox ([minLat, minLng, maxLat,
 *   maxLng], city.json); otherwise (no fix, outside, bbox unknown) "Walks in {city}".
 * - City: the active course's city when it has walks, else the first city in catalog order that has walks.
 * - One card per walk with its actions ON the card: Start (one tap: stream if needed, start, Now Walking), Demo walk
 *   (SIMULATED), a small download button (download / progress / downloaded) and "Remove download".
 */

export enum HomeHeader { IN_CITY = 'inCity', WALKS_IN = 'walksIn' }

/** "You're in {city}" only with a real fix inside the city's bbox. lat/lng NaN = no fix. */
export function homeHeader(lat: number, lng: number, bbox: number[]): HomeHeader {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || bbox.length < 4 || !bbox.every((v: number) => Number.isFinite(v))) {
    return HomeHeader.WALKS_IN;
  }
  const inside = lat >= bbox[0] && lat <= bbox[2] && lng >= bbox[1] && lng <= bbox[3];
  return inside ? HomeHeader.IN_CITY : HomeHeader.WALKS_IN;
}

/** The city Home lists: the active course's city when it has walks, else the first city (catalog order) with walks. */
export function homeCity(activeCityId: string, walkCityIds: string[]): string {
  if (activeCityId !== '' && walkCityIds.indexOf(activeCityId) >= 0) {
    return activeCityId;
  }
  return walkCityIds.length > 0 ? walkCityIds[0] : '';
}

/** The card's main button. */
export enum CardPrimary {
  START = 'start',           // one tap: (stream,) start, Now Walking
  CONTINUE = 'continue',     // this walk is running: open Now Walking
  PREPARING = 'preparing',   // fetching / activating / starting: "Preparing…", disabled
  UNAVAILABLE = 'unavailable' // not on the device and no server to fetch it from: disabled
}

export enum CardDownload { HIDDEN = 'hidden', DOWNLOAD = 'download', PROGRESS = 'progress', DONE = 'done' }

export class CardInput {
  /** Fully downloaded (offline). */
  downloaded: boolean = false;
  /** A newer version is on the server (downloaded only). */
  updateAvailable: boolean = false;
  /** Streamed copy on the device. */
  streamed: boolean = false;
  /** Download running. */
  downloading: boolean = false;
  /** Start / Demo walk is preparing this walk. */
  preparing: boolean = false;
  /** The last Start / Download of this walk failed. */
  failed: boolean = false;
  /** This walk is the running tour. */
  running: boolean = false;
  /** Another walk's tour is running (Start asks to end it first). */
  otherRunning: boolean = false;
  /** A course server is configured (fetch / download possible). */
  serverEnabled: boolean = false;
  /** This walk is the active course. */
  active: boolean = false;
  /** The active course's pack ships a demo track (meaningful only when `active`). */
  activeHasDemo: boolean = false;
}

export class CardActions {
  primary: CardPrimary = CardPrimary.START;
  /** "Demo walk" shown on the card. */
  demo: boolean = false;
  /** Buttons usable (false while preparing / downloading another way). */
  enabled: boolean = true;
  /** Start must first confirm ending the running tour. */
  confirmEnd: boolean = false;
  download: CardDownload = CardDownload.HIDDEN;
  /** "Remove download" offered (long-press / ⋯). */
  canRemove: boolean = false;
  /** Show the inline failure line. */
  showFailed: boolean = false;
}

export function cardActions(i: CardInput): CardActions {
  const a = new CardActions();
  const onDevice = i.downloaded || i.streamed;
  if (i.running) {
    a.primary = CardPrimary.CONTINUE;
  } else if (i.preparing) {
    a.primary = CardPrimary.PREPARING;
    a.enabled = false;
  } else if (!onDevice && !i.serverEnabled) {
    a.primary = CardPrimary.UNAVAILABLE;
    a.enabled = false;
  } else {
    a.primary = CardPrimary.START;
    a.confirmEnd = i.otherRunning;
  }
  // The demo track is known only once the walk's pack is loaded (active); a walk not yet active is offered the demo
  // when it can be made active (Start then reports a walk without a track).
  a.demo = !i.running && (i.active ? i.activeHasDemo : (onDevice || i.serverEnabled));
  if (i.downloading) {
    a.download = CardDownload.PROGRESS;
  } else if (i.downloaded && !i.updateAvailable) {
    a.download = CardDownload.DONE;
  } else if (i.serverEnabled) {
    a.download = CardDownload.DOWNLOAD;
  } else {
    a.download = i.downloaded ? CardDownload.DONE : CardDownload.HIDDEN;
  }
  a.canRemove = onDevice && !i.running && !i.downloading && !i.preparing;
  a.showFailed = i.failed && !i.preparing && !i.downloading;
  return a;
}

/**
 * Home "Explore" row ("All places in {city}", the full map with every place of the city, B13). It is offered whenever
 * Home lists a city, not only once a walk is loaded: with no walk on the device yet, a tap first makes one of the
 * city's walks active (PREPARE), and while the city's places pack is not on the device (no walk yet, or a streamed
 * walk, which carries only its own stops) the tap fetches that pack (GET_PLACES, the city's places only, not a whole
 * walk), then opens the map.
 */
export enum ExploreStep {
  HIDDEN = 'hidden',          // no city on Home and no walk loaded
  OPEN = 'open',              // the places are on the device: open the map
  PREPARE = 'prepare',        // no walk of this city is loaded: make one active, then GET_PLACES when needed
  GET_PLACES = 'getPlaces',   // a walk is loaded but the city's places are not on the device: fetch them, then open
  BUSY = 'busy'               // preparing / fetching: the row shows progress
}

export class ExploreInput {
  /** The city Home lists ('' = none known). */
  homeCityId: string = '';
  /** The active course is loaded (pack READY, a tour on it). */
  activeLoaded: boolean = false;
  /** The active course's city ('' = a self-contained course or none). */
  activeCityId: string = '';
  /** The active course's whole city (every place) is on the device (or it has no city). */
  placesOnDevice: boolean = false;
  /** A course server is configured (the places can be fetched). */
  serverEnabled: boolean = false;
  /** The row is already preparing / fetching. */
  busy: boolean = false;
}

export function exploreStep(i: ExploreInput): ExploreStep {
  const loadedHere = i.activeLoaded && (i.homeCityId === '' || i.activeCityId === '' || i.activeCityId === i.homeCityId);
  if (!loadedHere && i.homeCityId === '') {
    return ExploreStep.HIDDEN;
  }
  if (i.busy) {
    return ExploreStep.BUSY;
  }
  if (loadedHere) {
    // Without a server the map still opens on what is on the device (a streamed walk: its own stops).
    return i.placesOnDevice || !i.serverEnabled ? ExploreStep.OPEN : ExploreStep.GET_PLACES;
  }
  return i.serverEnabled ? ExploreStep.PREPARE : ExploreStep.HIDDEN;
}

/** A walk Home lists, for choosing which one Explore makes active. */
export class ExploreWalk {
  id: string = '';
  cityId: string = '';
  downloaded: boolean = false;
  streamed: boolean = false;

  constructor(id: string, cityId: string, downloaded: boolean, streamed: boolean) {
    this.id = id;
    this.cityId = cityId;
    this.downloaded = downloaded;
    this.streamed = streamed;
  }
}

/**
 * The walk Explore makes active when none of `cityId` is loaded: a downloaded one (activates offline and brings the
 * city's places), else a streamed one, else the first in list order. '' = none.
 */
export function exploreWalk(walks: ExploreWalk[], cityId: string): string {
  const here = walks.filter((w: ExploreWalk) => cityId === '' || w.cityId === '' || w.cityId === cityId);
  const dl = here.find((w: ExploreWalk) => w.downloaded);
  if (dl !== undefined) {
    return dl.id;
  }
  const st = here.find((w: ExploreWalk) => w.streamed);
  if (st !== undefined) {
    return st.id;
  }
  return here.length > 0 ? here[0].id : '';
}
