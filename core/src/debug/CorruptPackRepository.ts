/*
 * Debug fault injection for ARCHITECTURE §9 row 17 (task A10): a PackRepository that behaves like a bundled pack
 * whose pois.json does not parse. AppContainer uses it instead of the real pack only when
 * AppConfig.DEBUG_CORRUPT_PACK is true (false in git), so the "Offline city data is damaged" state can be shown on
 * the emulator without editing rawfiles. load() resolves (never rejects) with ok=false and one BLOCKING PACK_ERR,
 * and logs the row's line with src=debug; every accessor returns empty data, so no caller can crash on it.
 * Pure (no @kit import): unit-tested in TourController.test.
 */
import { AppIssue, IssueCode, IssueSeverity } from '../contracts/EngineTypes';
import { Lang, MapData, Narration, NarrationLength, Persona, Poi, RouteData, SourceRef, Tour }
  from '../contracts/Model';
import { LoggerPort, PackLoadResult, PackRepository } from '../contracts/Ports';
import { LogEvents } from '../app/LogEvents';

export const CORRUPT_PACK_DETAIL: string = 'PACK_PARSE pois.json (simulated)';

export class CorruptPackRepository implements PackRepository {
  private readonly log: LoggerPort;

  constructor(log: LoggerPort) {
    this.log = log;
  }

  load(): Promise<PackLoadResult> {
    this.log.error(LogEvents.PACK_ERR, 'file=pois.json reason=parse src=debug flag=DEBUG_CORRUPT_PACK');
    const issue: AppIssue = { code: IssueCode.PACK_ERR, severity: IssueSeverity.BLOCKING, detail: CORRUPT_PACK_DETAIL };
    const r: PackLoadResult = { ok: false, issues: [issue] };
    return Promise.resolve(r);
  }

  pois(): Poi[] {
    return [];
  }

  poi(id: string): Poi | undefined {
    return undefined;
  }

  tours(): Tour[] {
    return [];
  }

  personas(): Persona[] {
    return [];
  }

  routes(): RouteData {
    const r: RouteData = { nodeIds: [], durationsS: [], distancesM: [], detourFactor: 1, legs: [] };
    return r;
  }

  map(level: string): MapData {
    const d: MapData = { level: level, origin: { lat: 0, lng: 0 }, bounds: [], layers: [] };
    return d;
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    return undefined;
  }

  source(id: string): SourceRef | undefined {
    return undefined;
  }
}
