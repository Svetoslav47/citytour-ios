/*
 * "How it works" HUD rows (task B12, docs/DESIGN.md §3.6 HUD block, docs/OPPORTUNITIES.md §3.2): turns one
 * EngineSnapshot (plus the few values the snapshot does not carry: next-stop name, demo speed, the next stop's
 * trigger radii) into labelled, tabular text rows. Every value is read from the snapshot or passed in; a value
 * that is unavailable is shown as "n/a", never made up. The Demo walk is always labelled SIMULATED.
 * Row labels and values are technical (Kit names, units), like the log lines they mirror, so they are not localized.
 * Pure: no platform imports. Unit-tested in entry/src/test/HudRows.test.ets.
 */
import { EngineSnapshot, SignalQuality, TourPhase } from '../../contracts/EngineTypes';
import { Poi, TourStop } from '../../contracts/Model';
import { FixSource } from '../../contracts/Ports';
import { VoiceLabel } from '../../contracts/Settings';
import { TourConfig } from '../tour/TourConfig';
import { relativeBearing } from '../map/WalkDisplay';

export const NA: string = 'n/a';

/** Status dot of a row: ok = platform path live, warn = degraded, off = not running, sim = simulated, na = unknown. */
export enum HudTone { OK = 'ok', WARN = 'warn', OFF = 'off', SIM = 'sim', NA = 'na' }

export interface HudRow {
  key: string;                 // stable id suffix: hudRow_<key>
  label: string;
  value: string;
  tone: HudTone;
}

/** The arrival and "coming up" radii of one stop, exactly as the engine derives them. */
export interface TriggerRadii {
  arriveM: number;
  approachM: number;
}

export interface HudInput {
  snap: EngineSnapshot | undefined;
  nextName: string;            // '' = unknown
  demoSpeed: number;           // Demo walk speed multiplier; NaN = unknown
  trigger: TriggerRadii | undefined;
  /** SERVER.md §6: 'server online|offline|budget|disabled ...' (RemoteVoice.hudText); undefined = no row. */
  server?: string;
}

/**
 * The engine's radii for one tour stop (mirrors TourEngine.buildStops; cross-checked against the engine in the
 * test): tour stop override, else the POI's radius, else the default; scaled by the Settings trigger distance;
 * approach = tour stop override or the default, but at least arrive + 30 m (DESIGN §5.3).
 */
export function triggerRadii(stop: TourStop | undefined, poi: Poi | undefined, cfg: TourConfig): TriggerRadii | undefined {
  if (poi === undefined) {
    return undefined;
  }
  let trigR: number = cfg.defaultTriggerRadiusM;
  if (stop !== undefined && stop.triggerRadiusM !== undefined && stop.triggerRadiusM > 0) {
    trigR = stop.triggerRadiusM;
  } else if (poi.triggerRadiusM > 0) {
    trigR = poi.triggerRadiusM;
  }
  const scale: number = cfg.triggerRadiusScale;
  if (Number.isFinite(scale) && scale > 0) {
    trigR = Math.round(trigR * scale);
  }
  let appR: number = cfg.approachRadiusM;
  if (stop !== undefined && stop.approachRadiusM !== undefined && stop.approachRadiusM > 0) {
    appR = stop.approachRadiusM;
  }
  appR = Math.max(appR, trigR + 30);
  const r: TriggerRadii = { arriveM: trigR, approachM: appR };
  return r;
}

/** "180 m", "1.2 km"; n/a for NaN or negative. */
export function hudDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) {
    return NA;
  }
  if (m >= 1000) {
    return `${(Math.round(m / 100) / 10).toFixed(1)} km`;
  }
  return `${Math.round(m)} m`;
}

/** "212°" (0..359); n/a for NaN. */
export function hudDegrees(deg: number): string {
  if (!Number.isFinite(deg)) {
    return NA;
  }
  const d: number = Math.round(((deg % 360) + 360) % 360) % 360;
  return `${d}°`;
}

/** "+18°" / "-34°" / "0°"; n/a for NaN. */
export function hudSignedDegrees(deg: number): string {
  if (!Number.isFinite(deg)) {
    return NA;
  }
  const d: number = Math.round(deg);
  return d > 0 ? `+${d}°` : `${d}°`;
}

/** "1.3 m/s"; n/a for NaN or negative. */
export function hudSpeed(mps: number): string {
  if (!Number.isFinite(mps) || mps < 0) {
    return NA;
  }
  return `${mps.toFixed(1)} m/s`;
}

function row(key: string, label: string, value: string, tone: HudTone): HudRow {
  const r: HudRow = { key: key, label: label, value: value, tone: tone };
  return r;
}

function locationRow(s: EngineSnapshot, demoSpeed: number): HudRow {
  if (s.source === FixSource.DEMO) {
    const parts: string[] = ['Demo walk (SIMULATED)'];
    parts.push(Number.isFinite(demoSpeed) && demoSpeed > 0 ? `${demoSpeed}×` : `speed ${NA}`);
    if (s.platform.demoHold) {
      parts.push('demo assist: holding at stop');
    }
    // §5: in demo mode the real source keeps running as a shadow; its accuracy is real.
    parts.push(Number.isFinite(s.platform.realGpsAccuracyM) ?
      `real GPS ±${Math.round(s.platform.realGpsAccuracyM)} m` : `real GPS ${NA}`);
    return row('location', 'Location', parts.join(' · '), HudTone.SIM);
  }
  if (s.signal === SignalQuality.LOST) {
    return row('location', 'Location', 'Location Kit · no fix (signal lost)', HudTone.OFF);
  }
  const u = s.user;
  if (u === undefined || u.source !== FixSource.REAL || !Number.isFinite(u.accuracyM)) {
    return row('location', 'Location', `Location Kit · accuracy ${NA}`, HudTone.WARN);
  }
  const weak: boolean = s.signal === SignalQuality.POOR;
  return row('location', 'Location', `Location Kit · ±${Math.round(u.accuracyM)} m${weak ? ' · weak' : ''}`,
    weak ? HudTone.WARN : HudTone.OK);
}

function courseRow(s: EngineSnapshot): HudRow {
  const u = s.user;
  if (u === undefined) {
    return row('course', 'Course', `${NA} · ${NA}`, HudTone.NA);
  }
  const both: boolean = Number.isFinite(u.courseDeg) && Number.isFinite(u.speedMps);
  return row('course', 'Course', `${hudDegrees(u.courseDeg)} · ${hudSpeed(u.speedMps)}`, both ? HudTone.OK : HudTone.NA);
}

function nextRow(s: EngineSnapshot, name: string): HudRow {
  const n = s.next;
  if (n === undefined) {
    const done: boolean = s.phase === TourPhase.FINISHED || s.phase === TourPhase.ABORTED;
    return row('next', 'Next', done ? 'tour over' : NA, HudTone.NA);
  }
  const rel: number = s.user === undefined ? Number.NaN : relativeBearing(n.bearingDeg, s.user.courseDeg);
  const brg: string = Number.isFinite(rel) ? `brg ${hudDegrees(n.bearingDeg)} (${hudSignedDegrees(rel)})` :
    `brg ${hudDegrees(n.bearingDeg)}`;
  return row('next', 'Next', `${name === '' ? n.poiId : name} · ${hudDistance(n.distanceM)} · ${brg}`,
    Number.isFinite(n.distanceM) ? HudTone.OK : HudTone.NA);
}

function triggerRow(s: EngineSnapshot, t: TriggerRadii | undefined): HudRow {
  const radii: string = t === undefined ? `approach ${NA} · arrive ${NA}` :
    `approach ${hudDistance(t.approachM)} · arrive ${hudDistance(t.arriveM)}`;
  // The geofence state is shown only while it fires (approaching / at the stop), to keep the row one line.
  const live: boolean = s.phase === TourPhase.APPROACHING || s.phase === TourPhase.AT_STOP;
  return row('trigger', 'Trigger', live ? `${radii} · ${s.phase}` : radii, t === undefined ? HudTone.NA : HudTone.OK);
}

function routeRow(s: EngineSnapshot): HudRow {
  const parts: string[] = [s.offRoute ? 'OFF ROUTE · re-planned' : 'on route'];
  const n = s.next;
  if (n !== undefined && n.maneuverText !== '') {
    parts.push(Number.isFinite(n.maneuverDistM) ? `cue in ${hudDistance(n.maneuverDistM)}: ${n.maneuverText}` :
      `cue: ${n.maneuverText}`);
  } else {
    parts.push(`cue ${NA}`);
  }
  return row('route', 'Route', parts.join(' · '), s.offRoute ? HudTone.WARN : HudTone.OK);
}

function voiceName(label: VoiceLabel): string {
  switch (label) {
    case VoiceLabel.NATIVE:
      return 'native voice';
    case VoiceLabel.FALLBACK_ZH_READS_EN:
      return 'Fallback voice (zh-CN reads EN)';
    case VoiceLabel.PRERENDERED:
      return 'Studio voice (pre-recorded)';
    case VoiceLabel.TEXT_ONLY_PLATFORM:
      return 'text only (no platform voice)';
    case VoiceLabel.TEXT_ONLY_USER:
      return 'text only (your choice)';
    default:
      return NA;
  }
}

/**
 * PlatformStatus.ttsEngine: 'zh-CN/13' style, 'clips' (A13: a clips-only plan, e.g. spoken Polish), 'none' (text).
 * While a studio clip plays, the Core Speech engine still voices the lines without a clip (directions).
 */
function engineText(engine: string, label: VoiceLabel): string {
  if (engine === '' || engine === 'none') {
    return `Core Speech ${NA}`;
  }
  if (engine === 'clips') {
    return 'clips only, no TTS';
  }
  return label === VoiceLabel.PRERENDERED ? `Core Speech ${engine} for other lines` : `Core Speech ${engine}`;
}

function voiceRow(s: EngineSnapshot): HudRow {
  const parts: string[] = [voiceName(s.voiceLabel)];
  parts.push(engineText(s.platform.ttsEngine, s.voiceLabel));
  parts.push(s.nowPlaying === undefined ? 'idle' : s.paused ? 'paused' : s.speechText ? 'showing text' : 'speaking');
  let tone: HudTone = HudTone.OK;
  if (s.voiceLabel === VoiceLabel.FALLBACK_ZH_READS_EN) {
    tone = HudTone.WARN;
  } else if (s.voiceLabel === VoiceLabel.TEXT_ONLY_PLATFORM || s.voiceLabel === VoiceLabel.TEXT_ONLY_USER) {
    tone = HudTone.OFF;
  }
  return row('voice', 'Voice', parts.join(' · '), tone);
}

function sessionRow(s: EngineSnapshot): HudRow {
  if (!s.platform.avsActive) {
    return row('session', 'Session', 'AVSession inactive', HudTone.OFF);
  }
  return row('session', 'Session', `AVSession active · ${s.paused ? 'paused' : 'playing'}`, HudTone.OK);
}

function backgroundRow(s: EngineSnapshot): HudRow {
  return s.platform.bgRunning ?
    row('background', 'Background', 'LOCATION + AUDIO_PLAYBACK running', HudTone.OK) :
    row('background', 'Background', 'continuous task not running', HudTone.OFF);
}

const KEYS: string[] = ['location', 'course', 'next', 'trigger', 'route', 'voice', 'session', 'background'];
const LABELS: string[] = ['Location', 'Course', 'Next', 'Trigger', 'Route', 'Voice', 'Session', 'Background'];

/** The HUD's 8 rows, in DESIGN §3.6 order (Route added for A9's off-route / turn cue state). */
export function hudRows(input: HudInput): HudRow[] {
  const s: EngineSnapshot | undefined = input.snap;
  if (s === undefined) {
    return KEYS.map((k: string, i: number) => row(k, LABELS[i], NA, HudTone.NA));
  }
  return [
    locationRow(s, input.demoSpeed),
    courseRow(s),
    nextRow(s, input.nextName),
    triggerRow(s, input.trigger),
    routeRow(s),
    voiceRow(s),
    sessionRow(s),
    backgroundRow(s)
  ].concat(input.server !== undefined ? [serverRow(input.server)] : []);
}

/** Voice/Server row: the optional course + studio-voice server (tone from its state word). */
export function serverRow(text: string): HudRow {
  let tone: HudTone = HudTone.NA;
  if (text.startsWith('server online')) {
    tone = HudTone.OK;
  } else if (text.startsWith('server offline') || text.startsWith('server budget') || text.startsWith('server not')) {
    tone = HudTone.WARN;
  } else if (text.startsWith('server disabled')) {
    tone = HudTone.OFF;
  }
  return row('server', 'Server', text === '' ? NA : text, tone);
}
