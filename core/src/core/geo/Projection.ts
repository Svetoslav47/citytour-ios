/*
 * Local equirectangular (ENU) projection shared by the pack pipeline and the app (task A1). The app always builds it
 * from the loaded pack manifest's `origin` (Projection.fromOrigin); PACK_ORIGIN_* is only the pipeline's current
 * origin, the default for tests and fixtures.
 * Source: docs/ARCHITECTURE.md §3.2. Origin O = Rynek Główny (50.06143, 19.93658):
 *   x = (lng - lng0) * cos(lat0 * PI / 180) * 111320.0   // metres east
 *   y = (lat - lat0) * 110574.0                          // metres north
 * The constants must stay identical to the pipeline (scripts/pack, task B2); GeoMath.test pins
 * three reference points (origin, Wawel, Barbican) that B2 pins too.
 */
import { LatLng } from '../../contracts/Model';

export const PACK_ORIGIN_LAT: number = 50.06143;
export const PACK_ORIGIN_LNG: number = 19.93658;
/** Metres per degree of longitude at the equator. */
export const M_PER_DEG_LNG_EQUATOR: number = 111320.0;
/** Metres per degree of latitude. */
export const M_PER_DEG_LAT: number = 110574.0;

/** Projected metres from the origin: x east, y north. */
export interface XY {
  x: number;
  y: number;
}

export class Projection {
  readonly originLat: number;
  readonly originLng: number;
  private readonly mPerDegLng: number;

  constructor(originLat: number = PACK_ORIGIN_LAT, originLng: number = PACK_ORIGIN_LNG) {
    this.originLat = originLat;
    this.originLng = originLng;
    this.mPerDegLng = Math.cos(originLat * Math.PI / 180) * M_PER_DEG_LNG_EQUATOR;
  }

  static fromOrigin(origin: LatLng): Projection {
    return new Projection(origin.lat, origin.lng);
  }

  x(lng: number): number {
    return (lng - this.originLng) * this.mPerDegLng;
  }

  y(lat: number): number {
    return (lat - this.originLat) * M_PER_DEG_LAT;
  }

  toXY(lat: number, lng: number): XY {
    const p: XY = { x: this.x(lng), y: this.y(lat) };
    return p;
  }

  toLatLng(x: number, y: number): LatLng {
    const ll: LatLng = { lat: this.originLat + y / M_PER_DEG_LAT, lng: this.originLng + x / this.mPerDegLng };
    return ll;
  }
}
