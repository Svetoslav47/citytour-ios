/*
 * Map paint values (DESIGN §4.8), light and dark. Skia needs colour strings, so the tokens are mirrored here
 * from resources/{base,dark}/element/color.json. The map is muted so the route and plaques are the only
 * saturated things on it.
 */
export class MapPalette {
  land: string = '#EEEEEA';
  water: string = '#D3E1E6';
  green: string = '#DCE6D6';
  buildings: string = '#E2E0DA';
  buildingStroke: string = '#D3D0C8';
  majorStreet: string = '#FFFFFF';
  minorStreet: string = '#FFFFFF';
  path: string = '#FAFAF8';
  unesco: string = '#6B7176';
  routeNext: string = '#1D6B5B';
  routeLater: string = 'rgba(29,107,91,0.45)';
  routeWalked: string = 'rgba(107,113,118,0.6)';
  casing: string = '#FFFFFF';
  accent: string = '#1D6B5B';
  onAccent: string = '#FFFFFF';
  surface: string = '#FFFFFF';
  tertiary: string = '#6B7176';
  label: string = '#5A6066';
  labelHalo: string = '#EEEEEA';
  user: string = '#2F6FDE';
  userHalo: string = 'rgba(47,111,222,0.12)';
  userCone: string = 'rgba(47,111,222,0.30)';
  simulatedFg: string = '#7A4F00';
  simulatedBg: string = '#FFF1D6';
}

export const LIGHT: MapPalette = new MapPalette();

export const DARK: MapPalette = darkPalette();

function darkPalette(): MapPalette {
  const p = new MapPalette();
  p.land = '#151819';
  p.water = '#14222A';
  p.green = '#1A2620';
  p.buildings = '#202426';
  p.buildingStroke = '#2A2F32';
  p.majorStreet = '#2A2F32';
  p.minorStreet = '#24292C';
  p.path = '#202426';
  p.unesco = '#858C91';
  p.routeNext = '#6CC3AE';
  p.routeLater = 'rgba(108,195,174,0.45)';
  p.routeWalked = 'rgba(133,140,145,0.6)';
  p.casing = '#1A1D1F';
  p.accent = '#6CC3AE';
  p.onAccent = '#062A23';
  p.surface = '#1A1D1F';
  p.tertiary = '#858C91';
  p.label = '#A7ADB2';
  p.labelHalo = '#151819';
  p.user = '#5C93F0';
  p.userHalo = 'rgba(92,147,240,0.14)';
  p.userCone = 'rgba(92,147,240,0.30)';
  p.simulatedFg = '#F2C46B';
  p.simulatedBg = '#3A2C0D';
  return p;
}

/** World widths (metres) of line layers, clamped to a px range so they stay legible at every zoom. */
export class LineWidth {
  static readonly MAJOR_M: number = 9;
  static readonly MAJOR_MIN_PX: number = 2;
  static readonly MAJOR_MAX_PX: number = 12;
  static readonly MINOR_M: number = 6;
  static readonly MINOR_MIN_PX: number = 1;
  static readonly MINOR_MAX_PX: number = 8;
  static readonly PATH_M: number = 3;
  static readonly PATH_MIN_PX: number = 0.8;
  static readonly PATH_MAX_PX: number = 5;
  static readonly RIVER_M: number = 60;
}

/** Default minimum scale (px per metre) per layer when the pack does not say (ARCHITECTURE §3.2 LOD). */
export function defaultMinScale(layerId: string): number {
  switch (layerId) {
    case 'buildings':
      return 0.6;
    case 'paths':
      return 1.0;
    case 'minor':
      return 0.35;
    default:
      return 0;
  }
}
