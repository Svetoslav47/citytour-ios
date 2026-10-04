/*
 * Turn-by-turn wording between stops (task A9). Sources: docs/ARCHITECTURE.md §4.6 (which OSRM steps are spoken:
 * prepare at <= 30 m, now at <= 8 m, continue / new name only when the segment is longer than 250 m, depart merged
 * into the next-stop line, arrive left to the stop trigger; zh omits Polish street names, the UI shows them; leg 0
 * bearing guidance), §4.7 (off-route line, "New plan" line); docs/DESIGN.md §5.4 (decision points only, no
 * "continue straight" chatter, landmark before metric, relative directions, rounded distances, the screen uses the
 * same words as the voice), §5.1 (short spoken sentences).
 * The phrase templates live in core/content/Phrases.ets; this file decides what to say for a step and builds the
 * sentence. Pure: no platform imports.
 */
import { Lang, Maneuver, RouteStep } from '../../contracts/Model';
import { RelDir } from '../../contracts/EngineTypes';
import {
  PhraseKey, actionWithStreet, distancePhrase, maneuverAction, phrase, relDirPhrase
} from '../content/Phrases';

/** How a step is announced. */
export enum StepCue {
  NONE = 'none',          // depart, arrive, a straight turn, a short continue: silence means "keep going"
  TURN = 'turn',          // a decision point: prepare (<= 30 m) and now (<= 8 m) cues
  CONTINUE = 'continue'   // a long straight segment (> 250 m): one "Continue straight for about 300 metres" cue
}

/** The cue kind of an OSRM step (ARCHITECTURE §4.6). `longContinueM`: 250 m. */
export function stepCueKind(step: RouteStep, longContinueM: number): StepCue {
  if (step.maneuver === Maneuver.DEPART || step.maneuver === Maneuver.ARRIVE) {
    return StepCue.NONE;
  }
  const straight: boolean = step.modifier === 'straight' || step.modifier.length === 0;
  const plainContinue: boolean = step.maneuver === Maneuver.CONTINUE || step.maneuver === Maneuver.NEW_NAME;
  if (plainContinue || (straight && step.maneuver !== Maneuver.ROUNDABOUT)) {
    return step.distanceM > longContinueM ? StepCue.CONTINUE : StepCue.NONE;
  }
  return StepCue.TURN;
}

/** The step's action with its street, as spoken in `lang` (no street in zh). */
export function spokenAction(step: RouteStep, lang: Lang): string {
  return actionWithStreet(maneuverAction(step.maneuver, step.modifier, lang), step.streetName, lang);
}

/** The step's action with its street for the screen: zh shows the Polish name in brackets (it is never spoken). */
export function shownAction(step: RouteStep, lang: Lang): string {
  const a: string = maneuverAction(step.maneuver, step.modifier, lang);
  if (lang === Lang.ZH) {
    return step.streetName.length > 0 ? `${a}（${step.streetName}）` : a;
  }
  return actionWithStreet(a, step.streetName, lang);
}

/** "In 30 metres, turn left onto Grodzka." (+ ", then turn right" for a coalesced follow-up maneuver). */
export function prepareText(lang: Lang, step: RouteStep, distM: number, walkSpeedMps: number,
  then: RouteStep | undefined): string {
  const dist: string = distancePhrase(distM, lang, walkSpeedMps);
  if (then !== undefined) {
    return phrase(PhraseKey.NAV_PREPARE_THEN, lang, {
      dist: dist, action: spokenAction(step, lang), next: maneuverAction(then.maneuver, then.modifier, lang)
    });
  }
  return phrase(PhraseKey.NAV_PREPARE, lang, { dist: dist, action: spokenAction(step, lang) });
}

/** "Now turn left onto Grodzka." (+ ", then turn right"). */
export function nowText(lang: Lang, step: RouteStep, then: RouteStep | undefined): string {
  if (then !== undefined) {
    return phrase(PhraseKey.NAV_NOW_THEN, lang, {
      action: spokenAction(step, lang), next: maneuverAction(then.maneuver, then.modifier, lang)
    });
  }
  return phrase(PhraseKey.NAV_NOW, lang, { action: spokenAction(step, lang) });
}

/**
 * A long straight segment: "Walk straight past {landmark}." when a tour stop lies along it (landmark before
 * metric), else "Continue along Grodzka for about 300 metres." / "Continue straight for about 300 metres.".
 */
export function continueText(lang: Lang, step: RouteStep, walkSpeedMps: number, landmark: string): string {
  if (landmark.length > 0) {
    return phrase(PhraseKey.NAV_PASS, lang, { name: landmark });
  }
  const dist: string = distancePhrase(step.distanceM, lang, walkSpeedMps);
  if (step.streetName.length > 0) {     // zh: "along this road", the Polish name is never spoken
    return phrase(PhraseKey.NAV_CONTINUE_STREET, lang, { dist: dist, street: step.streetName });
  }
  return phrase(PhraseKey.NAV_CONTINUE, lang, { dist: dist });
}

/**
 * Bearing guidance (leg 0, no leg geometry, off the route): "Barbican is about 300 metres ahead on your left."
 * Without directions (spoken directions off, or HERE / unknown course): "Barbican is about 300 metres away."
 */
export function bearingText(lang: Lang, name: string, distM: number, dir: RelDir, walkSpeedMps: number,
  useDirections: boolean): string {
  const dist: string = distancePhrase(distM, lang, walkSpeedMps);
  if (!useDirections || dir === RelDir.HERE) {
    return phrase(PhraseKey.NAV_BEARING_NO_DIR, lang, { name: name, dist: dist });
  }
  return phrase(PhraseKey.NAV_BEARING, lang, { name: name, dist: dist, dir: relDirPhrase(dir, lang) });
}

/** ARCHITECTURE §4.7 P0 line: "You've left the route. Cloth Hall is about 200 metres behind you, on the right." */
export function offRouteSentences(lang: Lang, name: string, distM: number, dir: RelDir, walkSpeedMps: number,
  useDirections: boolean): string[] {
  const out: string[] = [phrase(PhraseKey.OFF_ROUTE, lang, {})];
  if (Number.isFinite(distM)) {
    out.push(bearingText(lang, name, distM, dir, walkSpeedMps, useDirections));
  }
  return out;
}

/** ARCHITECTURE §4.7: "New plan: we'll visit {b} first." */
export function replanSentence(lang: Lang, name: string): string {
  return phrase(PhraseKey.REPLAN_NEW, lang, { name: name });
}

/**
 * Screen text of the next maneuver (EngineSnapshot.next.maneuverText), the same words as the voice (DESIGN §5.4.6):
 * "Now turn left onto Grodzka." within `nowM`, else "In 120 metres, turn left onto Grodzka.". zh shows the street.
 */
export function maneuverUiText(lang: Lang, step: RouteStep, distM: number, walkSpeedMps: number, nowM: number): string {
  if (distM <= nowM) {
    return phrase(PhraseKey.NAV_NOW, lang, { action: shownAction(step, lang) });
  }
  return phrase(PhraseKey.NAV_PREPARE, lang, {
    dist: distancePhrase(distM, lang, walkSpeedMps), action: shownAction(step, lang)
  });
}
