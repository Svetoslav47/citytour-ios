/*
 * Narrations of the offline pack, per language, loaded lazily (only the languages actually asked for: the text
 * language, plus English when the guide speaks English over Polish text). Every narration is validated when it
 * is first about to be spoken or shown (memoised), with the tier and persona fallback chains of ARCHITECTURE
 * §7.4-7.5. Logs NARR_FALLBACK / NARR_PERSONA_FALLBACK once per slot.
 */
import { ContentTier, Lang, Narration, NarrationLength, Persona, Poi, ProvenanceKind } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { NarrationValidator, ValidationCtx } from '@citytour/core';
import { nameOnlyNarration, personaChain, selectNarration } from '@citytour/core';
import { parseNarrations } from '@citytour/core';

/** Reads `narrations/<lang>.json` as text; undefined when missing or unreadable. */
export type NarrationTextReader = (lang: Lang) => string | undefined;

export class NarrationRepository {
  private readonly reader: NarrationTextReader;
  private readonly poiOf: (id: string) => Poi | undefined;
  private readonly hasSource: (id: string) => boolean;
  private personas: Persona[] = [];
  private cityNouns: string[] = [];
  private slots: Map<string, Map<string, Narration[]>> = new Map<string, Map<string, Narration[]>>();
  private counts: Map<string, number> = new Map<string, number>();
  private validator: NarrationValidator = new NarrationValidator();
  private logged: Set<string> = new Set<string>();

  constructor(reader: NarrationTextReader, poiOf: (id: string) => Poi | undefined, hasSource: (id: string) => boolean) {
    this.reader = reader;
    this.poiOf = poiOf;
    this.hasSource = hasSource;
  }

  setPersonas(p: Persona[]): void {
    this.personas = p;
  }

  /** The city's own proper nouns (city.json), grounded for the proper-noun check. Set before the first get(). */
  setCityNouns(nouns: string[]): void {
    this.cityNouns = nouns;
  }

  /** Loads one language now (used for the default language at pack load). Returns the narration count. */
  ensure(lang: Lang): number {
    const have = this.counts.get(lang);
    if (have !== undefined) {
      return have;
    }
    const byId = new Map<string, Narration[]>();
    let n = 0;
    const t0 = Date.now();
    const text = this.reader(lang);
    if (text === undefined) {
      Log.w(LogEvents.PACK_ERR, `file=narrations/${lang}.json reason=missing blocking=false`);
    } else {
      const parsed = parseNarrations(`narrations/${lang}.json`, text, lang);
      if (parsed.error !== '') {
        Log.e(LogEvents.PACK_ERR, `file=narrations/${lang}.json reason=${parsed.error} blocking=false`);
      }
      for (const item of parsed.items) {
        const key = NarrationRepository.slotKey(item.poiId, item.personaId, item.lang, item.length);
        const list = byId.get(key);
        if (list === undefined) {
          byId.set(key, [item]);
        } else {
          list.push(item);
        }
        n++;
      }
      NarrationRepository.logDrops(parsed.drops.length, parsed.drops.length > 0 ? parsed.drops[0].reason : '',
        `narrations/${lang}.json`);
    }
    this.slots.set(lang, byId);
    this.counts.set(lang, n);
    Log.i(LogEvents.PACK_LOAD, `file=narrations/${lang}.json narr=${n} ms=${Date.now() - t0}`);
    return n;
  }

  /** Validated narration for the slot, with tier + persona fallback; undefined when the slot has nothing. */
  get(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    this.ensure(lang);
    const byId = this.slots.get(lang);
    if (byId === undefined) {
      return undefined;
    }
    const chain = personaChain(this.personas, personaId);
    if (chain.length === 0) {
      chain.push(personaId);
    }
    for (const persona of chain) {
      const candidates = byId.get(NarrationRepository.slotKey(poiId, persona, lang, len));
      if (candidates === undefined || candidates.length === 0) {
        continue;
      }
      const sel = selectNarration(candidates, this.validator, (n: Narration) => this.ctxFor(n));
      const slot = `${poiId}:${persona}:${lang}:${len}`;
      if (persona !== personaId) {
        this.logOnce(`p:${slot}`, LogEvents.NARR_PERSONA_FALLBACK,
          `poi=${poiId} lang=${lang} len=${len} from=${personaId} to=${persona}`);
      }
      if (sel.narration !== undefined) {
        if (sel.fellBack) {
          this.logOnce(`t:${slot}`, LogEvents.NARR_FALLBACK, `poi=${poiId} lang=${lang} len=${len} ` +
            `from=${sel.rejectedTier} to=${sel.narration.tier} reason=${sel.reason}`);
        }
        return sel.narration;
      }
      // Nothing valid in the pack for this slot: say less, never garbage.
      const poi = this.poiOf(poiId);
      const name = poi === undefined ? '' : (lang === Lang.ZH ? poi.names.zh : lang === Lang.PL ? poi.names.pl :
        poi.names.en) ?? poi.names.en ?? poi.names.pl ?? '';
      this.logOnce(`t:${slot}`, LogEvents.NARR_FALLBACK, `poi=${poiId} lang=${lang} len=${len} ` +
        `from=${sel.rejectedTier} to=${ContentTier.NAME_ONLY} reason=${sel.reason}`);
      return name === '' ? undefined : nameOnlyNarration(poiId, persona, lang, len, name);
    }
    return undefined;
  }

  count(lang: Lang): number {
    return this.counts.get(lang) ?? 0;
  }

  private ctxFor(n: Narration): ValidationCtx {
    const ctx = new ValidationCtx();
    const ids: string[] = [];
    for (const s of n.sources) {
      if (this.hasSource(s)) {
        ids.push(s);
      }
    }
    for (const c of n.claims) {
      if (c !== undefined && c !== null && this.hasSource(c.sourceId)) {
        ids.push(c.sourceId);
      }
    }
    ctx.sourceIds = ids;
    ctx.cityNouns = this.cityNouns;
    const poi = this.poiOf(n.poiId);
    if (poi !== undefined) {
      const names: string[] = [];
      if (poi.names.en !== undefined) {
        names.push(poi.names.en);
      }
      if (poi.names.pl !== undefined) {
        names.push(poi.names.pl);
      }
      if (poi.names.zh !== undefined) {
        names.push(poi.names.zh);
      }
      ctx.poiNames = names;
    }
    if (n.generatedBy !== undefined && n.generatedBy !== null &&
      n.generatedBy.kind === ProvenanceKind.MACHINE_TRANSLATION) {
      ctx.translatedFromTier = ContentTier.REVIEWED_HISTORIAN;   // MT is only made from reviewed English
    }
    return ctx;
  }

  private logOnce(key: string, event: string, kv: string): void {
    if (this.logged.has(key)) {
      return;
    }
    this.logged.add(key);
    Log.w(event, kv);
  }

  static slotKey(poiId: string, personaId: string, lang: string, len: string): string {
    return `${poiId}:${personaId}:${lang}:${len}`;
  }

  static logDrops(count: number, firstReason: string, file: string): void {
    if (count > 0) {
      Log.w(LogEvents.PACK_DROP, `file=${file} n=${count} first=${firstReason}`);
    }
  }
}
