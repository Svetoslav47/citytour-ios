/*
 * Now Walking bottom sheet detents (DESIGN §3.6.3). Pure maths, no @kit imports (unit-tested locally).
 * The sheet has a fixed expanded height and slides down by `offset` vp (translateY): 0 = EXPANDED,
 * `travel` = expandedH - peekH = COLLAPSED ("peek": only the next stop, distance, direction and play/pause show).
 * - Release: a fling faster than FLING_VPS decides by its direction; otherwise the nearer detent wins.
 * - Drag: the offset follows the finger, with a rubber band beyond either detent.
 * - Map: the follow camera keeps the user dot above the visible part of the sheet.
 */

export enum SheetDetent {
  EXPANDED = 0,
  COLLAPSED = 1
}

/** A fling at or above this speed (vp/s) picks the detent in its direction, whatever the offset. */
export const FLING_VPS: number = 600;
/** Peek content height (handle + next stop + distance + controls row), without the bottom safe area. */
export const PEEK_CONTENT_H: number = 156;
/** Rubber band past a detent: the sheet moves this fraction of the finger travel. */
export const RUBBER: number = 0.25;
/** Overlap of the sheet's rounded top over the map (the map runs this far under it). */
export const SHEET_OVERLAP: number = 24;

/** Peek height including the navigation-indicator inset, so no control sits under the gesture bar. */
export function peekHeight(bottomSafe: number): number {
  return PEEK_CONTENT_H + Math.max(0, finite(bottomSafe));
}

/** How far the sheet slides between the detents (>= 0). */
export function sheetTravel(expandedH: number, peekH: number): number {
  return Math.max(0, finite(expandedH) - finite(peekH));
}

/** Resting offset of a detent. */
export function detentOffset(d: SheetDetent, travel: number): number {
  return d === SheetDetent.COLLAPSED ? Math.max(0, finite(travel)) : 0;
}

/** Offset while dragging: start offset + finger dy, rubber-banded outside [0, travel]. */
export function dragOffset(startOffset: number, dy: number, travel: number): number {
  const t = Math.max(0, finite(travel));
  const raw = finite(startOffset) + finite(dy);
  if (raw < 0) {
    return raw * RUBBER;
  }
  if (raw > t) {
    return t + (raw - t) * RUBBER;
  }
  return raw;
}

/** Detent to settle on when the finger lifts at `offset` with vertical velocity `velocityY` (vp/s, + = down). */
export function resolveDetent(offset: number, velocityY: number, travel: number): SheetDetent {
  const v = finite(velocityY);
  if (v >= FLING_VPS) {
    return SheetDetent.COLLAPSED;
  }
  if (v <= -FLING_VPS) {
    return SheetDetent.EXPANDED;
  }
  const t = Math.max(0, finite(travel));
  if (t <= 0) {
    return SheetDetent.EXPANDED;
  }
  return finite(offset) > t / 2 ? SheetDetent.COLLAPSED : SheetDetent.EXPANDED;
}

/** Tap on the handle: the other detent. */
export function toggleDetent(d: SheetDetent): SheetDetent {
  return d === SheetDetent.COLLAPSED ? SheetDetent.EXPANDED : SheetDetent.COLLAPSED;
}

/** 0 = expanded .. 1 = collapsed, clamped (drives the peek / full-panel crossfade). */
export function collapseProgress(offset: number, travel: number): number {
  const t = finite(travel);
  if (t <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, finite(offset) / t));
}

/** Height of the sheet still on screen. */
export function visibleSheetHeight(expandedH: number, offset: number): number {
  return Math.max(0, finite(expandedH) - Math.max(0, finite(offset)));
}

/** Map box height: the map runs behind the sheet down to the peek's rounded top (it is never seen lower). */
export function mapBoxHeight(pageH: number, peekH: number): number {
  return Math.max(0, finite(pageH) - finite(peekH) + SHEET_OVERLAP);
}

/** Map follow bottom inset: the part of the map box the visible sheet covers, so the user dot stays in the band
 * between the header and the sheet. */
export function mapBottomInset(visibleSheetH: number, pageH: number, mapBoxH: number): number {
  const below = Math.max(0, finite(pageH) - finite(mapBoxH));   // page under the map box (always sheet)
  return Math.max(0, finite(visibleSheetH) - below);
}

/** Expanded sheet height: the page below the DESIGN map box, plus the sheet's overlap over the map. */
export function expandedHeight(pageH: number, mapBoxH: number, peekH: number): number {
  return Math.max(finite(peekH), finite(pageH) - finite(mapBoxH) + SHEET_OVERLAP);
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}
