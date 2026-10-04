/*
 * Spoken-style engine phrases in en, zh and pl (task A3; A9 adds the turn-by-turn templates).
 * Sources: docs/ARCHITECTURE.md §4.3 (arrival line = Phrases + RelDir + Poi.view), §4.5 (RelDir wording
 * table, "Look up at ..."), §9 row 5 (GPS lost line); docs/DESIGN.md §5.1 (short sentences, second person),
 * §5.3 (A1 approach, R1 arrival, T1 next stop, G1 GPS lost, F1 finish, W1 welcome + W1-sim), §5.4 (landmark
 * and relative direction, never cardinal; distances rounded: < 100 m to 10, < 500 m to 50, else minutes).
 * Gate G9: with directions off (spokenDirections = false, or relDir unreliable) the arrival line names the
 * place and says "Look for {feature}" with no left/right.
 * Polish is shown as text only (no Polish voice); its phrases avoid case agreement on inserted names.
 * A9 (turn-by-turn, ARCHITECTURE §4.6/§4.7, DESIGN §5.4): maneuverAction() maps every OSRM maneuver x modifier to a
 * short verb phrase per language; the NAV_* templates wrap it ("In 30 metres, turn left onto Grodzka.",
 * "Now turn left, then turn right."). Street names: en "onto {street}", pl "({street})" (no case agreement),
 * zh never (Polish names through the zh voice are unintelligible). OFF_ROUTE / REPLAN_NEW: the §4.7 lines.
 * Pure: no platform imports.
 */
import { Lang, LocalizedText, LookDir, Maneuver, ViewHint } from '../../contracts/Model';
import { RelDir } from '../../contracts/EngineTypes';

export enum PhraseKey {
  ARRIVAL = 'arrival',                 // "{name} is {dir}."
  ARRIVAL_HERE = 'arrivalHere',        // "You're at {name}."
  LOOK_UP = 'lookUp',
  LOOK_LEVEL = 'lookLevel',
  LOOK_DOWN = 'lookDown',
  LOOK_FOR = 'lookFor',                // G9 fallback, no direction
  APPROACH = 'approach',               // "In about {dist}, {dir}: {name}."
  APPROACH_NO_DIR = 'approachNoDir',
  NEXT_STOP = 'nextStop',              // "Next stop: {name}, about {dist} from here."
  NEXT_STOP_NO_DIST = 'nextStopNoDist',
  WELCOME = 'welcome',
  WELCOME_HINT = 'welcomeHint',
  WELCOME_SIMULATED = 'welcomeSimulated',
  GPS_LOST = 'gpsLost',
  FINISH = 'finish',
  FINISH_THANKS = 'finishThanks',
  // A9 turn-by-turn ({action} = maneuverAction(), with the street already attached where the language allows it)
  NAV_PREPARE = 'navPrepare',          // "In {dist}, {action}."
  NAV_PREPARE_THEN = 'navPrepareThen', // "In {dist}, {action}, then {next}."
  NAV_NOW = 'navNow',                  // "Now {action}."
  NAV_NOW_THEN = 'navNowThen',         // "Now {action}, then {next}."
  NAV_CONTINUE = 'navContinue',        // "Continue straight for about {dist}."
  NAV_CONTINUE_STREET = 'navContinueStreet', // "Continue along {street} for about {dist}." (zh: no street)
  NAV_PASS = 'navPass',                // "Walk straight past {name}."
  NAV_BEARING = 'navBearing',          // "{name} is about {dist} {dir}." (leg 0 / off-route bearing guidance)
  NAV_BEARING_NO_DIR = 'navBearingNoDir',
  OFF_ROUTE = 'offRoute',              // "You've left the route."
  REPLAN_NEW = 'replanNew'             // "New plan: we'll visit {name} first."
}

export const ALL_PHRASE_KEYS: PhraseKey[] = [
  PhraseKey.ARRIVAL, PhraseKey.ARRIVAL_HERE, PhraseKey.LOOK_UP, PhraseKey.LOOK_LEVEL, PhraseKey.LOOK_DOWN,
  PhraseKey.LOOK_FOR, PhraseKey.APPROACH, PhraseKey.APPROACH_NO_DIR, PhraseKey.NEXT_STOP,
  PhraseKey.NEXT_STOP_NO_DIST, PhraseKey.WELCOME, PhraseKey.WELCOME_HINT, PhraseKey.WELCOME_SIMULATED,
  PhraseKey.GPS_LOST, PhraseKey.FINISH, PhraseKey.FINISH_THANKS,
  PhraseKey.NAV_PREPARE, PhraseKey.NAV_PREPARE_THEN, PhraseKey.NAV_NOW, PhraseKey.NAV_NOW_THEN, PhraseKey.NAV_CONTINUE,
  PhraseKey.NAV_CONTINUE_STREET, PhraseKey.NAV_PASS, PhraseKey.NAV_BEARING, PhraseKey.NAV_BEARING_NO_DIR,
  PhraseKey.OFF_ROUTE, PhraseKey.REPLAN_NEW
];

/** Every OSRM maneuver type of the pack (contracts Model.Maneuver). */
export const ALL_MANEUVERS: Maneuver[] = [
  Maneuver.DEPART, Maneuver.TURN, Maneuver.CONTINUE, Maneuver.NEW_NAME, Maneuver.FORK, Maneuver.END_OF_ROAD,
  Maneuver.ROUNDABOUT, Maneuver.ARRIVE, Maneuver.OTHER
];

/** Every OSRM step modifier ('' = none). */
export const ALL_MODIFIERS: string[] = [
  'uturn', 'sharp right', 'right', 'slight right', 'straight', 'slight left', 'left', 'sharp left', ''
];

export const ALL_REL_DIRS: RelDir[] = [
  RelDir.AHEAD, RelDir.AHEAD_RIGHT, RelDir.RIGHT, RelDir.BEHIND_RIGHT, RelDir.BEHIND,
  RelDir.BEHIND_LEFT, RelDir.LEFT, RelDir.AHEAD_LEFT, RelDir.HERE
];

export const ALL_LANGS: Lang[] = [Lang.EN, Lang.ZH, Lang.PL];

/** Placeholder values; a template only uses the ones it names. */
export interface PhraseArgs {
  name?: string;
  dir?: string;
  dist?: string;
  feature?: string;
  tour?: string;
  action?: string;   // A9: maneuverAction() (+ street)
  next?: string;     // A9: the following maneuver of a coalesced cue
  street?: string;   // A9: street name (never in zh templates)
}

function enTemplate(key: PhraseKey): string {
  switch (key) {
    case PhraseKey.ARRIVAL: return '{name} is {dir}.';
    case PhraseKey.ARRIVAL_HERE: return 'You\'re at {name}.';
    case PhraseKey.LOOK_UP: return 'Look up at {feature}.';
    case PhraseKey.LOOK_LEVEL: return 'Look at {feature}.';
    case PhraseKey.LOOK_DOWN: return 'Look down at {feature}.';
    case PhraseKey.LOOK_FOR: return 'Look for {feature}.';
    case PhraseKey.APPROACH: return 'In about {dist}, {dir}: {name}.';
    case PhraseKey.APPROACH_NO_DIR: return 'In about {dist}: {name}.';
    case PhraseKey.NEXT_STOP: return 'Next stop: {name}, about {dist} from here.';
    case PhraseKey.NEXT_STOP_NO_DIST: return 'Next stop: {name}.';
    case PhraseKey.WELCOME: return 'Welcome! Today\'s walk: {tour}.';
    case PhraseKey.WELCOME_HINT: return 'Put your phone away. I\'ll tell you where to go and where to look.';
    case PhraseKey.WELCOME_SIMULATED: return 'This is a simulated walk, so I\'ll move you along the route myself.';
    case PhraseKey.GPS_LOST: return 'I\'ve lost the GPS signal. I\'ll continue when it\'s back.';
    case PhraseKey.FINISH: return 'That\'s the end of our walk.';
    case PhraseKey.FINISH_THANKS: return 'Thank you for walking with me.';
    case PhraseKey.NAV_PREPARE: return 'In {dist}, {action}.';
    case PhraseKey.NAV_PREPARE_THEN: return 'In {dist}, {action}, then {next}.';
    case PhraseKey.NAV_NOW: return 'Now {action}.';
    case PhraseKey.NAV_NOW_THEN: return 'Now {action}, then {next}.';
    case PhraseKey.NAV_CONTINUE: return 'Continue straight for about {dist}.';
    case PhraseKey.NAV_CONTINUE_STREET: return 'Continue along {street} for about {dist}.';
    case PhraseKey.NAV_PASS: return 'Walk straight past {name}.';
    case PhraseKey.NAV_BEARING: return '{name} is about {dist} {dir}.';
    case PhraseKey.NAV_BEARING_NO_DIR: return '{name} is about {dist} away.';
    case PhraseKey.OFF_ROUTE: return 'You\'ve left the route.';
    case PhraseKey.REPLAN_NEW: return 'New plan: we\'ll visit {name} first.';
    default: return '';
  }
}

function zhTemplate(key: PhraseKey): string {
  switch (key) {
    case PhraseKey.ARRIVAL: return '{name}{dir}。';
    case PhraseKey.ARRIVAL_HERE: return '您已到达{name}。';
    case PhraseKey.LOOK_UP: return '请抬头看{feature}。';
    case PhraseKey.LOOK_LEVEL: return '请看{feature}。';
    case PhraseKey.LOOK_DOWN: return '请低头看{feature}。';
    case PhraseKey.LOOK_FOR: return '请找一找{feature}。';
    case PhraseKey.APPROACH: return '再走大约{dist}，{name}{dir}。';
    case PhraseKey.APPROACH_NO_DIR: return '再走大约{dist}，就到{name}。';
    case PhraseKey.NEXT_STOP: return '下一站：{name}，距离大约{dist}。';
    case PhraseKey.NEXT_STOP_NO_DIST: return '下一站：{name}。';
    case PhraseKey.WELCOME: return '欢迎！今天的路线是{tour}。';
    case PhraseKey.WELCOME_HINT: return '请收好手机，我会告诉您往哪走、看什么。';
    case PhraseKey.WELCOME_SIMULATED: return '这是一次模拟步行，我会带您沿路线前进。';
    case PhraseKey.GPS_LOST: return 'GPS信号暂时丢失，恢复后我们继续。';
    case PhraseKey.FINISH: return '我们的游览到此结束。';
    case PhraseKey.FINISH_THANKS: return '感谢您与我一同漫步。';
    case PhraseKey.NAV_PREPARE: return '前方{dist}，{action}。';
    case PhraseKey.NAV_PREPARE_THEN: return '前方{dist}，{action}，然后{next}。';
    case PhraseKey.NAV_NOW: return '现在{action}。';
    case PhraseKey.NAV_NOW_THEN: return '现在{action}，然后{next}。';
    case PhraseKey.NAV_CONTINUE: return '继续直行大约{dist}。';
    case PhraseKey.NAV_CONTINUE_STREET: return '沿这条路继续直行大约{dist}。';
    case PhraseKey.NAV_PASS: return '直行，经过{name}。';
    case PhraseKey.NAV_BEARING: return '{name}{dir}，大约{dist}。';
    case PhraseKey.NAV_BEARING_NO_DIR: return '{name}距离大约{dist}。';
    case PhraseKey.OFF_ROUTE: return '您已偏离路线。';
    case PhraseKey.REPLAN_NEW: return '新的路线：我们先去{name}。';
    default: return '';
  }
}

function plTemplate(key: PhraseKey): string {
  switch (key) {
    case PhraseKey.ARRIVAL: return '{name} jest {dir}.';
    case PhraseKey.ARRIVAL_HERE: return 'Jesteś na miejscu: {name}.';
    case PhraseKey.LOOK_UP: return 'Spójrz w górę: {feature}.';
    case PhraseKey.LOOK_LEVEL: return 'Spójrz: {feature}.';
    case PhraseKey.LOOK_DOWN: return 'Spójrz w dół: {feature}.';
    case PhraseKey.LOOK_FOR: return 'Poszukaj wzrokiem: {feature}.';
    case PhraseKey.APPROACH: return 'Za około {dist}, {dir}: {name}.';
    case PhraseKey.APPROACH_NO_DIR: return 'Za około {dist}: {name}.';
    case PhraseKey.NEXT_STOP: return 'Następny przystanek: {name}, około {dist} stąd.';
    case PhraseKey.NEXT_STOP_NO_DIST: return 'Następny przystanek: {name}.';
    case PhraseKey.WELCOME: return 'Witaj! Dzisiejsza trasa: {tour}.';
    case PhraseKey.WELCOME_HINT: return 'Schowaj telefon, a powiem Ci, dokąd iść i na co patrzeć.';
    case PhraseKey.WELCOME_SIMULATED: return 'To symulowany spacer, więc poprowadzę Cię trasą automatycznie.';
    case PhraseKey.GPS_LOST: return 'Brak sygnału GPS. Ruszymy dalej, gdy wróci.';
    case PhraseKey.FINISH: return 'To już koniec naszego spaceru.';
    case PhraseKey.FINISH_THANKS: return 'Dziękuję za wspólny spacer.';
    case PhraseKey.NAV_PREPARE: return 'Za {dist} {action}.';
    case PhraseKey.NAV_PREPARE_THEN: return 'Za {dist} {action}, potem {next}.';
    case PhraseKey.NAV_NOW: return 'Teraz {action}.';
    case PhraseKey.NAV_NOW_THEN: return 'Teraz {action}, potem {next}.';
    case PhraseKey.NAV_CONTINUE: return 'Idź dalej prosto przez około {dist}.';
    case PhraseKey.NAV_CONTINUE_STREET: return 'Idź dalej prosto ({street}) przez około {dist}.';
    case PhraseKey.NAV_PASS: return 'Idź prosto, mijając: {name}.';
    case PhraseKey.NAV_BEARING: return '{name}: około {dist}, {dir}.';
    case PhraseKey.NAV_BEARING_NO_DIR: return '{name}: około {dist} stąd.';
    case PhraseKey.OFF_ROUTE: return 'Zeszliśmy z trasy.';
    case PhraseKey.REPLAN_NEW: return 'Nowy plan: najpierw {name}.';
    default: return '';
  }
}

/** The raw template of a phrase ('' if missing; the Phrases test asserts none is missing). */
export function phraseTemplate(key: PhraseKey, lang: Lang): string {
  switch (lang) {
    case Lang.ZH: return zhTemplate(key);
    case Lang.PL: return plTemplate(key);
    default: return enTemplate(key);
  }
}

/** RelDir wording of ARCHITECTURE §4.5 (zh and pl verbatim from the table; mirrored for the left side). */
export function relDirPhrase(dir: RelDir, lang: Lang): string {
  if (lang === Lang.ZH) {
    switch (dir) {
      case RelDir.AHEAD: return '就在正前方';
      case RelDir.AHEAD_RIGHT: return '在右前方';
      case RelDir.RIGHT: return '在您右侧';
      case RelDir.BEHIND_RIGHT: return '在您右后方';
      case RelDir.BEHIND: return '在您身后';
      case RelDir.BEHIND_LEFT: return '在您左后方';
      case RelDir.LEFT: return '在您左侧';
      case RelDir.AHEAD_LEFT: return '在左前方';
      default: return '就在这里';
    }
  }
  if (lang === Lang.PL) {
    switch (dir) {
      case RelDir.AHEAD: return 'prosto przed Tobą';
      case RelDir.AHEAD_RIGHT: return 'z przodu po prawej';
      case RelDir.RIGHT: return 'po Twojej prawej';
      case RelDir.BEHIND_RIGHT: return 'za Tobą, po prawej';
      case RelDir.BEHIND: return 'za Tobą';
      case RelDir.BEHIND_LEFT: return 'za Tobą, po lewej';
      case RelDir.LEFT: return 'po Twojej lewej';
      case RelDir.AHEAD_LEFT: return 'z przodu po lewej';
      default: return 'tutaj';
    }
  }
  switch (dir) {
    case RelDir.AHEAD: return 'straight ahead';
    case RelDir.AHEAD_RIGHT: return 'ahead on your right';
    case RelDir.RIGHT: return 'on your right';
    case RelDir.BEHIND_RIGHT: return 'behind you, on the right';
    case RelDir.BEHIND: return 'behind you';
    case RelDir.BEHIND_LEFT: return 'behind you, on the left';
    case RelDir.LEFT: return 'on your left';
    case RelDir.AHEAD_LEFT: return 'ahead on your left';
    default: return 'right here';
  }
}

function replaceAll(s: string, token: string, value: string | undefined): string {
  return value === undefined ? s : s.split(token).join(value);
}

/** Fills {name} {dir} {dist} {feature} {tour}. Placeholders without a value stay visible (tests catch it). */
export function fillTemplate(template: string, args: PhraseArgs): string {
  let s: string = template;
  s = replaceAll(s, '{name}', args.name);
  s = replaceAll(s, '{dir}', args.dir);
  s = replaceAll(s, '{dist}', args.dist);
  s = replaceAll(s, '{feature}', args.feature);
  s = replaceAll(s, '{tour}', args.tour);
  s = replaceAll(s, '{action}', args.action);
  s = replaceAll(s, '{next}', args.next);
  s = replaceAll(s, '{street}', args.street);
  return s;
}

export function phrase(key: PhraseKey, lang: Lang, args: PhraseArgs): string {
  return fillTemplate(phraseTemplate(key, lang), args);
}

/** Text in `lang`, falling back to en, then pl, then zh, then ''. */
export function localized(t: LocalizedText | undefined, lang: Lang): string {
  if (t === undefined) {
    return '';
  }
  const own: string | undefined = lang === Lang.ZH ? t.zh : (lang === Lang.PL ? t.pl : t.en);
  if (own !== undefined && own.length > 0) {
    return own;
  }
  if (t.en !== undefined && t.en.length > 0) {
    return t.en;
  }
  if (t.pl !== undefined && t.pl.length > 0) {
    return t.pl;
  }
  return t.zh !== undefined ? t.zh : '';
}

/**
 * Rounded distance words (DESIGN §5.4): under 100 m to the nearest 10 (at least 10), under 500 m to the
 * nearest 50, otherwise walking minutes at walkSpeedMps (at least 1). The caller adds "about".
 */
export function distancePhrase(distanceM: number, lang: Lang, walkSpeedMps: number): string {
  const d: number = Math.max(0, distanceM);
  if (d < 500) {
    const step: number = d < 100 ? 10 : 50;
    const m: number = Math.max(10, Math.round(d / step) * step);
    if (lang === Lang.ZH) {
      return `${m}米`;
    }
    return lang === Lang.PL ? `${m} metrów` : `${m} metres`;
  }
  const min: number = Math.max(1, Math.round(d / walkSpeedMps / 60));
  if (lang === Lang.ZH) {
    return `${min}分钟`;
  }
  if (lang === Lang.PL) {
    return min === 1 ? 'minuty' : `${min} minut`;   // after "około": genitive
  }
  return min === 1 ? '1 minute' : `${min} minutes`;
}

/**
 * Arrival line (§4.3 step 1): "{name} is {dir}." (or "You're at {name}." when HERE) plus the look clause
 * from Poi.view. With useDirections = false (gate G9) it is "You're at {name}." + "Look for {feature}.".
 */
export function arrivalSentences(lang: Lang, name: string, dir: RelDir, view: ViewHint | undefined,
  useDirections: boolean): string[] {
  const out: string[] = [];
  if (!useDirections || dir === RelDir.HERE) {
    out.push(phrase(PhraseKey.ARRIVAL_HERE, lang, { name: name }));
  } else {
    out.push(phrase(PhraseKey.ARRIVAL, lang, { name: name, dir: relDirPhrase(dir, lang) }));
  }
  const feature: string = view === undefined ? '' : localized(view.feature, lang);
  if (view !== undefined && feature.length > 0) {
    let key: PhraseKey = PhraseKey.LOOK_FOR;
    if (useDirections) {
      key = view.look === LookDir.UP ? PhraseKey.LOOK_UP :
        (view.look === LookDir.DOWN ? PhraseKey.LOOK_DOWN : PhraseKey.LOOK_LEVEL);
    }
    out.push(phrase(key, lang, { feature: feature }));
  }
  return out;
}

/** Approach cue (DESIGN §5.3 A1): "In about 80 metres, on your left: St Mary's Basilica." */
export function approachSentence(lang: Lang, name: string, dir: RelDir, distanceM: number,
  walkSpeedMps: number, useDirections: boolean): string {
  const dist: string = distancePhrase(distanceM, lang, walkSpeedMps);
  if (!useDirections || dir === RelDir.HERE) {
    return phrase(PhraseKey.APPROACH_NO_DIR, lang, { name: name, dist: dist });
  }
  return phrase(PhraseKey.APPROACH, lang, { name: name, dist: dist, dir: relDirPhrase(dir, lang) });
}

/** Next-stop line (DESIGN §5.3 T1). distanceM NaN = unknown (no fix yet). */
export function nextStopSentence(lang: Lang, name: string, distanceM: number, walkSpeedMps: number): string {
  if (!Number.isFinite(distanceM)) {
    return phrase(PhraseKey.NEXT_STOP_NO_DIST, lang, { name: name });
  }
  return phrase(PhraseKey.NEXT_STOP, lang, { name: name, dist: distancePhrase(distanceM, lang, walkSpeedMps) });
}

/** Welcome (DESIGN §5.3 W1, W1-sim). The simulated sentence is the spoken SIMULATED label. */
export function welcomeSentences(lang: Lang, tourTitle: string, simulated: boolean): string[] {
  const out: string[] = [
    phrase(PhraseKey.WELCOME, lang, { tour: tourTitle }),
    phrase(PhraseKey.WELCOME_HINT, lang, {})
  ];
  if (simulated) {
    out.push(phrase(PhraseKey.WELCOME_SIMULATED, lang, {}));
  }
  return out;
}

/** GPS lost (ARCHITECTURE §9 row 5), spoken once per episode. */
export function gpsLostSentence(lang: Lang): string {
  return phrase(PhraseKey.GPS_LOST, lang, {});
}

/** Finish (DESIGN §5.3 F1). */
export function finishSentences(lang: Lang): string[] {
  return [phrase(PhraseKey.FINISH, lang, {}), phrase(PhraseKey.FINISH_THANKS, lang, {})];
}

// ---------------------------------------------------------------- A9: turn-by-turn

/** Direction class of an OSRM modifier. */
enum TurnDir { LEFT, RIGHT, SLIGHT_LEFT, SLIGHT_RIGHT, SHARP_LEFT, SHARP_RIGHT, STRAIGHT, UTURN }

function turnDirOf(modifier: string): TurnDir {
  switch (modifier) {
    case 'left': return TurnDir.LEFT;
    case 'right': return TurnDir.RIGHT;
    case 'slight left': return TurnDir.SLIGHT_LEFT;
    case 'slight right': return TurnDir.SLIGHT_RIGHT;
    case 'sharp left': return TurnDir.SHARP_LEFT;
    case 'sharp right': return TurnDir.SHARP_RIGHT;
    case 'uturn': return TurnDir.UTURN;
    default: return TurnDir.STRAIGHT;
  }
}

function isLeftish(d: TurnDir): boolean {
  return d === TurnDir.LEFT || d === TurnDir.SLIGHT_LEFT || d === TurnDir.SHARP_LEFT;
}

function isRightish(d: TurnDir): boolean {
  return d === TurnDir.RIGHT || d === TurnDir.SLIGHT_RIGHT || d === TurnDir.SHARP_RIGHT;
}

function baseTurn(d: TurnDir, lang: Lang): string {
  if (lang === Lang.ZH) {
    switch (d) {
      case TurnDir.LEFT: return '左转';
      case TurnDir.RIGHT: return '右转';
      case TurnDir.SLIGHT_LEFT: return '向左前方走';
      case TurnDir.SLIGHT_RIGHT: return '向右前方走';
      case TurnDir.SHARP_LEFT: return '向左后方急转';
      case TurnDir.SHARP_RIGHT: return '向右后方急转';
      case TurnDir.UTURN: return '掉头';
      default: return '直行';
    }
  }
  if (lang === Lang.PL) {
    switch (d) {
      case TurnDir.LEFT: return 'skręć w lewo';
      case TurnDir.RIGHT: return 'skręć w prawo';
      case TurnDir.SLIGHT_LEFT: return 'odbij w lewo';
      case TurnDir.SLIGHT_RIGHT: return 'odbij w prawo';
      case TurnDir.SHARP_LEFT: return 'skręć ostro w lewo';
      case TurnDir.SHARP_RIGHT: return 'skręć ostro w prawo';
      case TurnDir.UTURN: return 'zawróć';
      default: return 'idź prosto';
    }
  }
  switch (d) {
    case TurnDir.LEFT: return 'turn left';
    case TurnDir.RIGHT: return 'turn right';
    case TurnDir.SLIGHT_LEFT: return 'bear left';
    case TurnDir.SLIGHT_RIGHT: return 'bear right';
    case TurnDir.SHARP_LEFT: return 'turn sharp left';
    case TurnDir.SHARP_RIGHT: return 'turn sharp right';
    case TurnDir.UTURN: return 'turn around';
    default: return 'go straight on';
  }
}

function sideWord(d: TurnDir, lang: Lang, left: string, right: string, straight: string): string {
  return isLeftish(d) ? left : (isRightish(d) ? right : straight);
}

/**
 * Short spoken-style verb phrase for an OSRM maneuver x modifier (ARCHITECTURE §4.6 "Templates"), lower case so
 * it can follow "In 30 metres," / "Now". Deterministic code, not AI. Never empty.
 */
export function maneuverAction(m: Maneuver, modifier: string, lang: Lang): string {
  const d: TurnDir = turnDirOf(modifier);
  const base: string = baseTurn(d, lang);
  switch (m) {
    case Maneuver.END_OF_ROAD:
      if (lang === Lang.ZH) {
        return `在路的尽头${base}`;
      }
      return lang === Lang.PL ? `na końcu ulicy ${base}` : `${base} at the end of the street`;
    case Maneuver.FORK:
      if (d === TurnDir.UTURN) {
        return base;
      }
      if (lang === Lang.ZH) {
        return `在岔路口${sideWord(d, lang, '靠左', '靠右', '直行')}`;
      }
      if (lang === Lang.PL) {
        return `na rozwidleniu ${sideWord(d, lang, 'trzymaj się lewej', 'trzymaj się prawej', 'idź prosto')}`;
      }
      return sideWord(d, lang, 'keep left at the fork', 'keep right at the fork', 'keep straight on at the fork');
    case Maneuver.ROUNDABOUT:
      if (lang === Lang.ZH) {
        return '绕过环岛';
      }
      return lang === Lang.PL ? 'obejdź rondo' : 'go around the roundabout';
    case Maneuver.CONTINUE:
    case Maneuver.NEW_NAME:
      if (d !== TurnDir.STRAIGHT) {
        return base;
      }
      if (lang === Lang.ZH) {
        return '继续直行';
      }
      return lang === Lang.PL ? 'idź dalej prosto' : 'continue straight';
    case Maneuver.DEPART:
      if (lang === Lang.ZH) {
        return `出发，${base}`;
      }
      if (lang === Lang.PL) {
        return `ruszaj: ${base}`;
      }
      return sideWord(d, lang, 'set off to the left', 'set off to the right', 'set off straight ahead');
    case Maneuver.ARRIVE:
      if (lang === Lang.ZH) {
        return sideWord(d, lang, '目的地在左侧', '目的地在右侧', '到达目的地');
      }
      if (lang === Lang.PL) {
        return sideWord(d, lang, 'cel jest po lewej', 'cel jest po prawej', 'jesteś u celu');
      }
      return sideWord(d, lang, 'the stop is on your left', 'the stop is on your right', 'you arrive at the stop');
    default:
      return base;   // TURN, OTHER
  }
}

/** The action with the street attached where the language speaks it: en "onto X", pl "(X)", zh never. */
export function actionWithStreet(action: string, street: string, lang: Lang): string {
  if (street.length === 0 || lang === Lang.ZH) {
    return action;
  }
  return lang === Lang.PL ? `${action} (${street})` : `${action} onto ${street}`;
}

/** First letter upper case (UI captions that start with the action). */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.substring(1);
}
