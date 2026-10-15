// Every FINITE sentence the tour engine can speak for one tour besides the stop stories (task A13 phase 3), so the
// fixed system lines, arrival lines and turn-by-turn cues can be pre-rendered in the studio voice too.
//
// The app plays a clip when sha256(utf8(Utterance.text)) matches a manifest entry, so this file must produce the
// exact strings of common/src/main/ets/core/content/Phrases.ets + core/route/Guidance.ets + core/tour/TourEngine.ets.
// It is a port of those templates and of the LegTracker cue rules. The guarantee that the port is exact is
// entry/src/test/SystemLines.test.ets: it calls the real ArkTS functions on every case of
// core/test/fixtures/SystemLinesGolden.ts (written by `node scripts/voice/system-lines.mjs --write-golden`)
// and asserts the same text and the same SHA-256; scripts/voice/system-lines.test.mjs asserts the golden file is
// up to date with this generator. Change a template in Phrases.ets => regenerate the golden => the ArkTS test fails
// until this port matches again.
//
// Groups (manifest `length` field; clips are keyed by text hash, poiId ''):
//   system  : welcome (real tour title, with/without the simulated-walk line), finish, GPS lost, "You've left the
//             route.", "New plan: we'll visit {stop} first.", "Next stop: {stop}." (no fix yet)
//   arrival : "{stop} is {dir}." / "You're at {stop}." + the look line from Poi.view, every RelDir, directions on/off
//   nav     : A9 cues of the pack legs: "In 10|20|30 metres, {action}[, then {next}]." and "Now {action}[, then
//             {next}].", plus "Continue ... for about N." / "Walk straight past {stop}." for long straight steps
// Still native TTS (live numbers, not pre-rendered): approach "In about N metres ...", "Next stop: X, about N from
// here.", bearing guidance and the second off-route sentence ("X is about N metres behind you"). numericCases()
// enumerates them anyway (every stop x direction x distance bucket) for the course server's allowed-lines set
// (docs/SERVER.md §4), and the golden holds samples of them so their exactness is tested the same way.
//
// Usage: node scripts/voice/system-lines.mjs [--course <courseId>] [--lang en] [--group nav] [--nav-legs all|tour]   (prints the lines)
//        node scripts/voice/system-lines.mjs --write-golden                                     (ArkTS fixture)
// Node 22+, stdlib only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_COURSE_ID, resolveCourse } from '../pack/lib/course.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const DEFAULT_PACK_DIR = join(ROOT, 'data/course/krakow/packs/krakow');
export const DEFAULT_TOUR_ID = 'royal-route';
export const GOLDEN_PATH = join(ROOT, 'core/test/fixtures/SystemLinesGolden.ts');
export const GROUPS = ['system', 'arrival', 'nav'];
// The golden stores the first 16 hex chars of Node's SHA-256 of each text; the ArkTS test compares its own hash.
export const GOLDEN_SHA_CHARS = 16;
export const LANGS = ['en', 'pl', 'zh'];

// TourConfig / NavConfig defaults (core/tour/TourConfig.ets, core/route/LegTracker.ets).
export const WALK_SPEED_MPS = 1.3;
export const PREPARE_M = 30;
export const NOW_M = 8;
export const LONG_CONTINUE_M = 250;
export const COALESCE_M = 25;
// A "then" follow-up is rendered when the next turn is within COALESCE_M + this slack (geometry rounding).
export const COALESCE_SLACK_M = 5;
// The distances a "prepare" cue can say: it fires for 8 m < d <= 30 m, rounded to 10 m => 10, 20, 30.
export const PREPARE_DISTS = [10, 20, 30];

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------- Phrases.ets port

const T = {
  en: {
    arrival: '{name} is {dir}.', arrivalHere: 'You\'re at {name}.', lookUp: 'Look up at {feature}.',
    lookLevel: 'Look at {feature}.', lookDown: 'Look down at {feature}.', lookFor: 'Look for {feature}.',
    nextStopNoDist: 'Next stop: {name}.', welcome: 'Welcome! Today\'s walk: {tour}.',
    welcomeHint: 'Put your phone away. I\'ll tell you where to go and where to look.',
    welcomeSimulated: 'This is a simulated walk, so I\'ll move you along the route myself.',
    gpsLost: 'I\'ve lost the GPS signal. I\'ll continue when it\'s back.', finish: 'That\'s the end of our walk.',
    finishThanks: 'Thank you for walking with me.', navPrepare: 'In {dist}, {action}.',
    navPrepareThen: 'In {dist}, {action}, then {next}.', navNow: 'Now {action}.', navNowThen: 'Now {action}, then {next}.',
    navContinue: 'Continue straight for about {dist}.', navContinueStreet: 'Continue along {street} for about {dist}.',
    navPass: 'Walk straight past {name}.', offRoute: 'You\'ve left the route.', replanNew: 'New plan: we\'ll visit {name} first.',
    approach: 'In about {dist}, {dir}: {name}.', approachNoDir: 'In about {dist}: {name}.',
    nextStop: 'Next stop: {name}, about {dist} from here.', navBearing: '{name} is about {dist} {dir}.',
    navBearingNoDir: '{name} is about {dist} away.'
  },
  zh: {
    arrival: '{name}{dir}。', arrivalHere: '您已到达{name}。', lookUp: '请抬头看{feature}。', lookLevel: '请看{feature}。',
    lookDown: '请低头看{feature}。', lookFor: '请找一找{feature}。', nextStopNoDist: '下一站：{name}。',
    welcome: '欢迎！今天的路线是{tour}。', welcomeHint: '请收好手机，我会告诉您往哪走、看什么。',
    welcomeSimulated: '这是一次模拟步行，我会带您沿路线前进。', gpsLost: 'GPS信号暂时丢失，恢复后我们继续。',
    finish: '我们的游览到此结束。', finishThanks: '感谢您与我一同漫步。', navPrepare: '前方{dist}，{action}。',
    navPrepareThen: '前方{dist}，{action}，然后{next}。', navNow: '现在{action}。', navNowThen: '现在{action}，然后{next}。',
    navContinue: '继续直行大约{dist}。', navContinueStreet: '沿这条路继续直行大约{dist}。', navPass: '直行，经过{name}。',
    offRoute: '您已偏离路线。', replanNew: '新的路线：我们先去{name}。',
    approach: '再走大约{dist}，{name}{dir}。', approachNoDir: '再走大约{dist}，就到{name}。',
    nextStop: '下一站：{name}，距离大约{dist}。', navBearing: '{name}{dir}，大约{dist}。', navBearingNoDir: '{name}距离大约{dist}。'
  },
  pl: {
    arrival: '{name} jest {dir}.', arrivalHere: 'Jesteś na miejscu: {name}.', lookUp: 'Spójrz w górę: {feature}.',
    lookLevel: 'Spójrz: {feature}.', lookDown: 'Spójrz w dół: {feature}.', lookFor: 'Poszukaj wzrokiem: {feature}.',
    nextStopNoDist: 'Następny przystanek: {name}.', welcome: 'Witaj! Dzisiejsza trasa: {tour}.',
    welcomeHint: 'Schowaj telefon, a powiem Ci, dokąd iść i na co patrzeć.',
    welcomeSimulated: 'To symulowany spacer, więc poprowadzę Cię trasą automatycznie.',
    gpsLost: 'Brak sygnału GPS. Ruszymy dalej, gdy wróci.', finish: 'To już koniec naszego spaceru.',
    finishThanks: 'Dziękuję za wspólny spacer.', navPrepare: 'Za {dist} {action}.',
    navPrepareThen: 'Za {dist} {action}, potem {next}.', navNow: 'Teraz {action}.', navNowThen: 'Teraz {action}, potem {next}.',
    navContinue: 'Idź dalej prosto przez około {dist}.', navContinueStreet: 'Idź dalej prosto ({street}) przez około {dist}.',
    navPass: 'Idź prosto, mijając: {name}.', offRoute: 'Zeszliśmy z trasy.', replanNew: 'Nowy plan: najpierw {name}.',
    approach: 'Za około {dist}, {dir}: {name}.', approachNoDir: 'Za około {dist}: {name}.',
    nextStop: 'Następny przystanek: {name}, około {dist} stąd.', navBearing: '{name}: około {dist}, {dir}.',
    navBearingNoDir: '{name}: około {dist} stąd.'
  }
};

export const REL_DIRS = ['ahead', 'aheadRight', 'right', 'behindRight', 'behind', 'behindLeft', 'left', 'aheadLeft', 'here'];

const REL = {
  en: {
    ahead: 'straight ahead', aheadRight: 'ahead on your right', right: 'on your right',
    behindRight: 'behind you, on the right', behind: 'behind you', behindLeft: 'behind you, on the left',
    left: 'on your left', aheadLeft: 'ahead on your left', here: 'right here'
  },
  zh: {
    ahead: '就在正前方', aheadRight: '在右前方', right: '在您右侧', behindRight: '在您右后方', behind: '在您身后',
    behindLeft: '在您左后方', left: '在您左侧', aheadLeft: '在左前方', here: '就在这里'
  },
  pl: {
    ahead: 'prosto przed Tobą', aheadRight: 'z przodu po prawej', right: 'po Twojej prawej',
    behindRight: 'za Tobą, po prawej', behind: 'za Tobą', behindLeft: 'za Tobą, po lewej', left: 'po Twojej lewej',
    aheadLeft: 'z przodu po lewej', here: 'tutaj'
  }
};

function fill(template, args) {
  let s = template;
  for (const k of ['name', 'dir', 'dist', 'feature', 'tour', 'action', 'next', 'street']) {
    if (args[k] !== undefined) {
      s = s.split(`{${k}}`).join(args[k]);
    }
  }
  return s;
}

export function phrase(key, lang, args = {}) {
  const t = (T[lang] || T.en)[key];
  if (t === undefined) {
    throw new Error(`no template ${key}`);
  }
  return fill(t, args);
}

/** Phrases.localized: own language, else en, pl, zh, ''. */
export function localized(t, lang) {
  if (!t) {
    return '';
  }
  const own = t[lang];
  if (typeof own === 'string' && own.length > 0) {
    return own;
  }
  for (const l of ['en', 'pl']) {
    if (typeof t[l] === 'string' && t[l].length > 0) {
      return t[l];
    }
  }
  return typeof t.zh === 'string' ? t.zh : '';
}

/** Phrases.distancePhrase (JS Math.round == ArkTS Math.round). */
export function distancePhrase(distanceM, lang, walkSpeedMps = WALK_SPEED_MPS) {
  const d = Math.max(0, distanceM);
  if (d < 500) {
    const step = d < 100 ? 10 : 50;
    const m = Math.max(10, Math.round(d / step) * step);
    return lang === 'zh' ? `${m}米` : lang === 'pl' ? `${m} metrów` : `${m} metres`;
  }
  const min = Math.max(1, Math.round(d / walkSpeedMps / 60));
  if (lang === 'zh') {
    return `${min}分钟`;
  }
  if (lang === 'pl') {
    return min === 1 ? 'minuty' : `${min} minut`;
  }
  return min === 1 ? '1 minute' : `${min} minutes`;
}

export function welcomeSentences(lang, tourTitle, simulated) {
  const out = [phrase('welcome', lang, { tour: tourTitle }), phrase('welcomeHint', lang)];
  if (simulated) {
    out.push(phrase('welcomeSimulated', lang));
  }
  return out;
}

export function finishSentences(lang) {
  return [phrase('finish', lang), phrase('finishThanks', lang)];
}

export function arrivalSentences(lang, name, dir, view, useDirections) {
  const out = [];
  if (!useDirections || dir === 'here') {
    out.push(phrase('arrivalHere', lang, { name }));
  } else {
    out.push(phrase('arrival', lang, { name, dir: REL[lang][dir] }));
  }
  const feature = view ? localized(view.feature, lang) : '';
  if (view && feature.length > 0) {
    let key = 'lookFor';
    if (useDirections) {
      key = view.look === 'up' ? 'lookUp' : view.look === 'down' ? 'lookDown' : 'lookLevel';
    }
    out.push(phrase(key, lang, { feature }));
  }
  return out;
}

// ---------------------------------------------------------------- numeric lines (live distances)
// Phrases.approachSentence / nextStopSentence and Guidance.bearingText / offRouteSentences. They are not pre-rendered
// (too many), but the course server's allowed-lines set for POST /v1/tts must hold every one the app can say, so
// numericCases() enumerates them for every stop x direction x distance bucket (server/src/publish).

/** Phrases.approachSentence. */
export function approachSentence(lang, name, dir, distanceM, useDirections, walkSpeedMps = WALK_SPEED_MPS) {
  const dist = distancePhrase(distanceM, lang, walkSpeedMps);
  if (!useDirections || dir === 'here') {
    return phrase('approachNoDir', lang, { name, dist });
  }
  return phrase('approach', lang, { name, dist, dir: REL[lang][dir] });
}

/** Phrases.nextStopSentence (distanceM NaN = no fix yet). */
export function nextStopSentence(lang, name, distanceM, walkSpeedMps = WALK_SPEED_MPS) {
  if (!Number.isFinite(distanceM)) {
    return phrase('nextStopNoDist', lang, { name });
  }
  return phrase('nextStop', lang, { name, dist: distancePhrase(distanceM, lang, walkSpeedMps) });
}

/** Guidance.bearingText. */
export function bearingText(lang, name, distM, dir, useDirections, walkSpeedMps = WALK_SPEED_MPS) {
  const dist = distancePhrase(distM, lang, walkSpeedMps);
  if (!useDirections || dir === 'here') {
    return phrase('navBearingNoDir', lang, { name, dist });
  }
  return phrase('navBearing', lang, { name, dist, dir: REL[lang][dir] });
}

/** Guidance.offRouteSentences: "You've left the route." + the bearing line when the distance is known. */
export function offRouteSentences(lang, name, distM, dir, useDirections, walkSpeedMps = WALK_SPEED_MPS) {
  const out = [phrase('offRoute', lang)];
  if (Number.isFinite(distM)) {
    out.push(bearingText(lang, name, distM, dir, useDirections, walkSpeedMps));
  }
  return out;
}

// The longest distance the allowed set covers, in walking minutes. Further than this the app's line is not in
// the set and it falls back to the built-in voice.
export const MAX_MINUTES = 60;

/**
 * Every distinct distance wording distancePhrase can produce from 0 m up to MAX_MINUTES of walking, each with one
 * input distance (metres) that produces it: 10..100 m step 10, 150..500 m step 50, then 6..MAX_MINUTES minutes.
 * Derived by sweeping the real function (0.5 m steps), so a change of the rounding rules changes the set.
 */
export function distanceBuckets(lang = 'en', walkSpeedMps = WALK_SPEED_MPS, maxMinutes = MAX_MINUTES) {
  const out = [];
  const seen = new Set();
  const maxM = (maxMinutes + 0.49) * 60 * walkSpeedMps;
  for (let d = 0; d <= maxM; d += 0.5) {
    const p = distancePhrase(d, lang, walkSpeedMps);
    if (!seen.has(p)) {
      seen.add(p);
      out.push({ distM: d, text: p });
    }
  }
  return out;
}

/** Numeric cases for every stop (all tours of the pack) x direction x bucket x language. */
export function numericCases(stopNamesByLang, opts = {}) {
  const langs = opts.langs || LANGS;
  const cases = [];
  const add = (f, lang, args, out) => cases.push({ group: 'numeric', f, lang, args, out: Array.isArray(out) ? out : [out] });
  for (const lang of langs) {
    const buckets = opts.distances ? opts.distances.map((d) => ({ distM: d })) : distanceBuckets(lang);
    for (const name of stopNamesByLang[lang] || []) {
      for (const b of buckets) {
        const d = b.distM;
        add('nextStop', lang, { name, distM: d }, nextStopSentence(lang, name, d));
        for (const useDir of [true, false]) {
          for (const dir of REL_DIRS) {
            if (!useDir && dir !== 'here') {
              continue;
            }
            add('approach', lang, { name, dir, distM: d, useDir }, approachSentence(lang, name, dir, d, useDir));
            add('offRouteDist', lang, { name, dir, distM: d, useDir }, offRouteSentences(lang, name, d, dir, useDir));
          }
        }
      }
    }
  }
  return cases;
}

/** Localized names of the stops of a pack tour per language. */
export function stopNames(pack, langs = LANGS) {
  const out = {};
  for (const lang of langs) {
    out[lang] = pack.tour.stops.map((s) => pack.poisById.get(s.poiId)).filter(Boolean)
      .map((p) => localized(p.names, lang));
  }
  return out;
}

const TURN = {
  en: { left: 'turn left', right: 'turn right', slightLeft: 'bear left', slightRight: 'bear right',
    sharpLeft: 'turn sharp left', sharpRight: 'turn sharp right', uturn: 'turn around', straight: 'go straight on' },
  zh: { left: '左转', right: '右转', slightLeft: '向左前方走', slightRight: '向右前方走', sharpLeft: '向左后方急转',
    sharpRight: '向右后方急转', uturn: '掉头', straight: '直行' },
  pl: { left: 'skręć w lewo', right: 'skręć w prawo', slightLeft: 'odbij w lewo', slightRight: 'odbij w prawo',
    sharpLeft: 'skręć ostro w lewo', sharpRight: 'skręć ostro w prawo', uturn: 'zawróć', straight: 'idź prosto' }
};

function turnDirOf(modifier) {
  switch (modifier) {
    case 'left': return 'left';
    case 'right': return 'right';
    case 'slight left': return 'slightLeft';
    case 'slight right': return 'slightRight';
    case 'sharp left': return 'sharpLeft';
    case 'sharp right': return 'sharpRight';
    case 'uturn': return 'uturn';
    default: return 'straight';
  }
}

const leftish = (d) => d === 'left' || d === 'slightLeft' || d === 'sharpLeft';
const rightish = (d) => d === 'right' || d === 'slightRight' || d === 'sharpRight';
const side = (d, l, r, s) => leftish(d) ? l : rightish(d) ? r : s;

const MANEUVERS = ['depart', 'turn', 'continue', 'new name', 'fork', 'end of road', 'roundabout', 'arrive', 'other'];

/** Phrases.maneuverAction. */
export function maneuverAction(m, modifier, lang) {
  const d = turnDirOf(modifier);
  const base = TURN[lang][d];
  switch (MANEUVERS.includes(m) ? m : 'other') {
    case 'end of road':
      return lang === 'zh' ? `在路的尽头${base}` : lang === 'pl' ? `na końcu ulicy ${base}` : `${base} at the end of the street`;
    case 'fork':
      if (d === 'uturn') {
        return base;
      }
      if (lang === 'zh') {
        return `在岔路口${side(d, '靠左', '靠右', '直行')}`;
      }
      if (lang === 'pl') {
        return `na rozwidleniu ${side(d, 'trzymaj się lewej', 'trzymaj się prawej', 'idź prosto')}`;
      }
      return side(d, 'keep left at the fork', 'keep right at the fork', 'keep straight on at the fork');
    case 'roundabout':
      return lang === 'zh' ? '绕过环岛' : lang === 'pl' ? 'obejdź rondo' : 'go around the roundabout';
    case 'continue':
    case 'new name':
      if (d !== 'straight') {
        return base;
      }
      return lang === 'zh' ? '继续直行' : lang === 'pl' ? 'idź dalej prosto' : 'continue straight';
    case 'depart':
      if (lang === 'zh') {
        return `出发，${base}`;
      }
      if (lang === 'pl') {
        return `ruszaj: ${base}`;
      }
      return side(d, 'set off to the left', 'set off to the right', 'set off straight ahead');
    case 'arrive':
      if (lang === 'zh') {
        return side(d, '目的地在左侧', '目的地在右侧', '到达目的地');
      }
      if (lang === 'pl') {
        return side(d, 'cel jest po lewej', 'cel jest po prawej', 'jesteś u celu');
      }
      return side(d, 'the stop is on your left', 'the stop is on your right', 'you arrive at the stop');
    default:
      return base;
  }
}

export function actionWithStreet(action, street, lang) {
  if (!street || lang === 'zh') {
    return action;
  }
  return lang === 'pl' ? `${action} (${street})` : `${action} onto ${street}`;
}

// ---------------------------------------------------------------- Guidance.ets / LegTracker.ets port

/** Guidance.stepCueKind: 'none' | 'turn' | 'continue'. */
export function stepCueKind(step, longContinueM = LONG_CONTINUE_M) {
  const m = MANEUVERS.includes(step.maneuver) ? step.maneuver : 'other';
  if (m === 'depart' || m === 'arrive') {
    return 'none';
  }
  const straight = step.modifier === 'straight' || step.modifier.length === 0;
  const plainContinue = m === 'continue' || m === 'new name';
  if (plainContinue || (straight && m !== 'roundabout')) {
    return step.distanceM > longContinueM ? 'continue' : 'none';
  }
  return 'turn';
}

const spokenAction = (step, lang) => actionWithStreet(maneuverAction(step.maneuver, step.modifier, lang),
  step.streetName, lang);

export function prepareText(lang, step, distM, then) {
  const dist = distancePhrase(distM, lang);
  if (then) {
    return phrase('navPrepareThen', lang, { dist, action: spokenAction(step, lang),
      next: maneuverAction(then.maneuver, then.modifier, lang) });
  }
  return phrase('navPrepare', lang, { dist, action: spokenAction(step, lang) });
}

export function nowText(lang, step, then) {
  if (then) {
    return phrase('navNowThen', lang, { action: spokenAction(step, lang),
      next: maneuverAction(then.maneuver, then.modifier, lang) });
  }
  return phrase('navNow', lang, { action: spokenAction(step, lang) });
}

export function continueText(lang, step, landmark) {
  if (landmark) {
    return phrase('navPass', lang, { name: landmark });
  }
  const dist = distancePhrase(step.distanceM, lang);
  if (step.streetName) {
    return phrase('navContinueStreet', lang, { dist, street: step.streetName });
  }
  return phrase('navContinue', lang, { dist });
}

/** Distance along the leg polyline of each step (LegTracker.alongOfStep). */
export function stepAlongs(leg) {
  const xs = [];
  const ys = [];
  const cum = [];
  const g = leg.geometry || [];
  for (let i = 0; i + 1 < g.length; i += 2) {
    const x = g[i];
    const y = g[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    cum.push(xs.length === 0 ? 0 : cum[cum.length - 1] + Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]));
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  return leg.steps.map((s) => {
    if (n === 0) {
      return 0;
    }
    if (s.geomIndex >= 0 && s.geomIndex < n && g.length === n * 2) {
      return cum[s.geomIndex];
    }
    let best = Infinity;
    let along = 0;
    for (let i = 0; i + 1 < n; i++) {
      const dx = xs[i + 1] - xs[i];
      const dy = ys[i + 1] - ys[i];
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((s.x - xs[i]) * dx + (s.y - ys[i]) * dy) / L2)) : 0;
      const d = Math.hypot(xs[i] + t * dx - s.x, ys[i] + t * dy - s.y);
      if (d < best) {
        best = d;
        along = cum[i] + t * (cum[i + 1] - cum[i]);
      }
    }
    return along;
  });
}

/** LegTracker.followUp with slack: the next TURN step within coalesce + slack after step k, else -1. */
export function followUp(leg, alongs, cues, k, limitM = COALESCE_M + COALESCE_SLACK_M) {
  for (let j = k + 1; j < leg.steps.length; j++) {
    if (alongs[j] - alongs[k] > limitM) {
      return -1;
    }
    if (cues[j] === 'turn') {
      return j;
    }
  }
  return -1;
}

// ---------------------------------------------------------------- enumeration

/**
 * Golden cases: one call of a real ArkTS function with its inputs and its expected output (string[]).
 * f: welcome | finish | gpsLost | offRoute | replan | nextStopNoDist | arrival | prepare | now | continue
 */
function step(s) {
  return { maneuver: s.maneuver, modifier: s.modifier || '', streetName: s.streetName || '', distanceM: s.distanceM };
}

/**
 * Every case of every group for one tour. pack: { tour, poisById: Map, legs: RouteLeg[] }.
 * opts: { langs, groups, navLegs: 'all' | 'tour' }
 */
export function enumerateCases(pack, opts = {}) {
  const langs = opts.langs || LANGS;
  const groups = opts.groups || GROUPS;
  const navLegs = opts.navLegs || 'all';
  const stops = pack.tour.stops.map((s) => pack.poisById.get(s.poiId)).filter(Boolean);
  const cases = [];
  const add = (group, f, lang, args, out) => cases.push({ group, f, lang, args, out: Array.isArray(out) ? out : [out] });
  for (const lang of langs) {
    const title = localized(pack.tour.titles, lang);
    const names = stops.map((p) => localized(p.names, lang));
    if (groups.includes('system')) {
      for (const sim of [false, true]) {
        add('system', 'welcome', lang, { title, sim }, welcomeSentences(lang, title, sim));
      }
      add('system', 'finish', lang, {}, finishSentences(lang));
      add('system', 'gpsLost', lang, {}, phrase('gpsLost', lang));
      add('system', 'offRoute', lang, {}, phrase('offRoute', lang));
      for (const name of names) {
        add('system', 'replan', lang, { name }, phrase('replanNew', lang, { name }));
        add('system', 'nextStopNoDist', lang, { name }, phrase('nextStopNoDist', lang, { name }));
      }
    }
    if (groups.includes('arrival')) {
      stops.forEach((p, i) => {
        for (const useDir of [true, false]) {
          for (const dir of REL_DIRS) {
            if (!useDir && dir !== 'here') {
              continue;                    // directions off: the dir is ignored, one case is enough
            }
            add('arrival', 'arrival', lang, { name: names[i], dir, useDir, view: p.view || null },
              arrivalSentences(lang, names[i], dir, p.view, useDir));
          }
        }
      });
    }
    if (groups.includes('nav')) {
      const tourIds = pack.tour.stops.map((s) => s.poiId);
      const legs = navLegs === 'tour' ?
        pack.legs.filter((l) => tourIds.indexOf(l.toPoiId) === tourIds.indexOf(l.fromPoiId) + 1) : pack.legs;
      const nameById = new Map(stops.map((p, i) => [p.id, names[i]]));
      for (const leg of legs) {
        if (!nameById.has(leg.toPoiId)) {
          continue;
        }
        const cues = leg.steps.map((s) => stepCueKind(step(s)));
        const alongs = stepAlongs(leg);
        leg.steps.forEach((raw, k) => {
          const s = step(raw);
          if (cues[k] === 'turn') {
            const j = followUp(leg, alongs, cues, k);
            const thens = j >= 0 ? [null, step(leg.steps[j])] : [null];
            for (const then of thens) {
              for (const d of PREPARE_DISTS) {
                add('nav', 'prepare', lang, { step: s, distM: d, then }, prepareText(lang, s, d, then));
              }
              add('nav', 'now', lang, { step: s, then }, nowText(lang, s, then));
            }
          } else if (cues[k] === 'continue') {
            add('nav', 'continue', lang, { step: s, landmark: '' }, continueText(lang, s, ''));
            for (const [id, name] of nameById) {
              if (id !== leg.toPoiId) {
                add('nav', 'continue', lang, { step: s, landmark: name }, continueText(lang, s, name));
              }
            }
          }
        });
      }
    }
  }
  return dedupeCases(cases);
}

function caseKey(c) {
  return `${c.f}|${c.lang}|${JSON.stringify(c.args)}`;
}

function dedupeCases(cases) {
  const seen = new Set();
  return cases.filter((c) => {
    const k = caseKey(c);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

/** One render line per unique (lang, text); the first group that produces a text owns it. */
export function linesFromCases(cases) {
  const seen = new Set();
  const out = [];
  for (const c of cases) {
    for (const text of c.out) {
      const k = `${c.lang}|${text}`;
      if (text.length === 0 || seen.has(k)) {
        continue;
      }
      seen.add(k);
      out.push({ lang: c.lang, group: c.group, text, textSha256: sha256Hex(text) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- pack I/O

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function loadPack(packDir = DEFAULT_PACK_DIR, tourId = DEFAULT_TOUR_ID) {
  const tours = readJson(join(packDir, 'tours.json'));
  const list = Array.isArray(tours) ? tours : tours.tours || [];
  const tour = list.find((t) => t.id === tourId) || list[0];
  if (!tour) {
    throw new Error(`no tour ${tourId} in ${packDir}/tours.json`);
  }
  const poisRaw = readJson(join(packDir, 'pois.json'));
  const pois = Array.isArray(poisRaw) ? poisRaw : poisRaw.pois || [];
  const routes = existsSync(join(packDir, 'routes.json')) ? readJson(join(packDir, 'routes.json')) : { legs: [] };
  return { tour, poisById: new Map(pois.map((p) => [p.id, p])), legs: Array.isArray(routes.legs) ? routes.legs : [] };
}

// ---------------------------------------------------------------- golden fixture (ArkTS)

const q = (s) => JSON.stringify(s);

function stepLit(s) {
  return s === null ? 'undefined' :
    `st(${q(s.maneuver)}, ${q(s.modifier)}, ${q(s.streetName)}, ${s.distanceM})`;
}

function caseLit(c) {
  const a = c.args;
  const out = `[${c.out.map(q).join(', ')}], [${c.out.map((t) => q(sha256Hex(t).slice(0, GOLDEN_SHA_CHARS))).join(', ')}]`;
  const L = q(c.lang);
  switch (c.f) {
    case 'welcome': return `  g('welcome', ${L}, [${q(a.title)}], [${a.sim ? 1 : 0}], undefined, undefined, ${out}),`;
    case 'replan':
    case 'nextStopNoDist': return `  g(${q(c.f)}, ${L}, [${q(a.name)}], [], undefined, undefined, ${out}),`;
    case 'arrival': {
      const v = a.view ? `, ${q(a.view.look)}, ${q(localizedRaw(a.view.feature))}` : '';
      return `  g('arrival', ${L}, [${q(a.name)}, ${q(a.dir)}${v}], [${a.useDir ? 1 : 0}], undefined, undefined, ${out}),`;
    }
    case 'prepare': return `  g('prepare', ${L}, [], [${a.distM}], ${stepLit(a.step)}, ${stepLit(a.then)}, ${out}),`;
    case 'now': return `  g('now', ${L}, [], [], ${stepLit(a.step)}, ${stepLit(a.then)}, ${out}),`;
    case 'continue': return `  g('continue', ${L}, [${q(a.landmark)}], [], ${stepLit(a.step)}, undefined, ${out}),`;
    case 'nextStop': return `  g('nextStop', ${L}, [${q(a.name)}], [${a.distM}], undefined, undefined, ${out}),`;
    case 'approach':
    case 'offRouteDist':
      return `  g(${q(c.f)}, ${L}, [${q(a.name)}, ${q(a.dir)}], [${a.distM}, ${a.useDir ? 1 : 0}], undefined, undefined, ${out}),`;
    default: return `  g(${q(c.f)}, ${L}, [], [], undefined, undefined, ${out}),`;
  }
}

/** The feature LocalizedText as one JSON string (the ArkTS test parses it back). */
function localizedRaw(t) {
  return JSON.stringify(t || {});
}

export function goldenSource(cases) {
  const lines = [
    '// GENERATED by `node scripts/voice/system-lines.mjs --write-golden` - do not edit by hand.',
    '// Every finite non-story sentence the engine speaks for the pack tour, with the inputs of the real ArkTS call',
    '// that produces it (SystemLines.test.ets checks text + SHA-256; system-lines.test.mjs checks this file is current).',
    "import { Maneuver, RouteStep } from '../../src';",
    '',
    'export interface GoldenCase {',
    '  f: string;',
    '  lang: string;',
    '  s: string[];',
    '  n: number[];',
    '  step?: RouteStep;',
    '  then?: RouteStep;',
    '  out: string[];',
    '  sha: string[];   // first 16 hex chars of sha256(utf8(out[i])) computed by Node crypto',
    '}',
    '',
    'function st(m: string, modifier: string, street: string, distanceM: number): RouteStep {',
    '  const r: RouteStep = {',
    '    maneuver: m as Maneuver, modifier: modifier, streetName: street, distanceM: distanceM, durationS: 0,',
    '    geomIndex: 0, x: 0, y: 0',
    '  };',
    '  return r;',
    '}',
    '',
    'function g(f: string, lang: string, s: string[], n: number[], step: RouteStep | undefined,',
    '  then: RouteStep | undefined, out: string[], sha: string[]): GoldenCase {',
    '  const c: GoldenCase = { f: f, lang: lang, s: s, n: n, step: step, then: then, out: out, sha: sha };',
    '  return c;',
    '}',
    '',
    `export const GOLDEN_CASE_COUNT: number = ${cases.length};`,
    '',
    'export const GOLDEN_CASES: GoldenCase[] = ['
  ];
  for (const c of cases) {
    lines.push(caseLit(c));
  }
  lines.push('];', '');
  return lines.join('\n');
}

/** The golden covers every group, every language and every pack leg (the superset any render can use). */
export function goldenCases(pack) {
  return enumerateCases(pack, { langs: LANGS, groups: GROUPS, navLegs: 'all' }).concat(numericGoldenCases(pack));
}

// Sample inputs for the numeric golden: the edges of every rounding band (0 m, 94/95 m -> 90/100, 474/475 m ->
// 450/500, 499/500 m -> 500 m / 6 min, minutes), so the ArkTS test proves the port's distancePhrase too.
export const NUMERIC_GOLDEN_DISTANCES = [0, 37, 94, 95, 124, 474, 475, 499.5, 500, 780, 4680];

/** Numeric golden: the first and last stop of the tour, every direction, the sample distances. */
export function numericGoldenCases(pack) {
  const names = stopNames(pack);
  const pick = {};
  for (const l of LANGS) {
    pick[l] = [names[l][0], names[l][names[l].length - 1]];
  }
  return numericCases(pick, { distances: NUMERIC_GOLDEN_DISTANCES });
}

// ---------------------------------------------------------------- CLI

export function main(argv) {
  const o = { langs: LANGS, groups: GROUPS, navLegs: 'all', writeGolden: false, pack: DEFAULT_PACK_DIR, tour: DEFAULT_TOUR_ID };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--lang' || a === '--langs') {
      o.langs = val().split(',');
    } else if (a === '--group' || a === '--groups') {
      o.groups = val().split(',');
    } else if (a === '--nav-legs') {
      o.navLegs = val();
    } else if (a === '--pack') {
      o.pack = resolve(val());
    } else if (a === '--tour-id') {
      o.tour = val();
    } else if (a === '--course') {
      const c = resolveCourse({ course: val() });
      o.pack = c.packDir;
      o.tour = c.tourId;
      o.course = c.courseId;
    } else if (a === '--write-golden') {
      o.writeGolden = true;
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  if (o.writeGolden && o.course && o.course !== DEFAULT_COURSE_ID) {
    throw new Error('--write-golden is for the default course (the ArkTS golden fixture is the Royal Route)');
  }
  const pack = loadPack(o.pack, o.tour);
  if (o.writeGolden) {
    const cases = goldenCases(pack);
    writeFileSync(GOLDEN_PATH, goldenSource(cases));
    console.log(`system-lines: wrote ${cases.length} cases -> ${GOLDEN_PATH}`);
    return 0;
  }
  const lines = linesFromCases(enumerateCases(pack, o));
  for (const l of lines) {
    console.log(`${l.lang}\t${l.group}\t${l.text}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`system-lines: ${e && e.message ? e.message : e}`);
    process.exit(2);
  }
}
