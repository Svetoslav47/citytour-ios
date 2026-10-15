# Prompt `translate-v1`: Polish and Chinese machine translations of the Historian stop scripts

The exact, public instruction set used to translate the English Historian scripts (`historian-v1`) into Polish (`pl`) and Simplified Chinese (`zh`) (task B7, docs/PLAN.md). It contains no secrets. Every narration translated with it carries `generatedBy.kind = mt`, `translatedFrom = en`, `model` and `promptId: translate-v1` in its provenance, and the app labels it **"Machine-translated"**.

- **Who translates:** a Claude Code agent (model `claude-opus-5-5`) working inside the repository. It is the machine translator: it writes the translation itself; no API key, no translation service and no network call is involved.
- **When:** only on request ("refresh the pl/zh translation of `<poiId>`"), after the English file changed. The pack build never translates.
- **Review state:** a translation inherits the review state of its English source. It is an AI draft (`grounded-ai`) until a human approves the English file, and it becomes `reviewed` only while it is a translation of the current English text. It is never presented as reviewed by a speaker of that language (docs/ARCHITECTURE.md §7.4).

## Inputs (nothing else)

1. `scripts/pack/review/<courseId>/<poiId>.en.md`: the teaser, full and deep sections, the claims and the view hint.
2. The stop names in the course's tour file (`data/tours/royal-route.json`, or `data/tours/<tourId>.json` for another course) (pl, zh).
3. For established local name forms only: the Polish and Chinese source texts in `data/raw/wiki/stops-text-{pl,zh}.json` and `summaries-{pl,zh}.json`.

Translate what the English says, sentence by sentence. Add no fact, number, name or nuance that is not in the English script. Drop nothing.

## Rules

- **Same structure.** The same sections (teaser, full, deep when the English has it), the same paragraphs, **one sentence per line**, and the same sentences as the English wherever natural (a merge or split only when the target language needs it).
- **Spoken style.** Natural, warm guide speech for listening, not a literal word-for-word rendering. Polish: informal second person singular ("Stoisz przed…", "Spójrz…"). Chinese: Simplified script, 你, short clauses, every line ends with 。！or？.
- **Names.** Use the established local form, not a transliteration of the English:
  - Polish: Barbakan, Brama Floriańska, Bazylika Mariacka / kościół Mariacki, Sukiennice, Rynek Główny, Wieża Ratuszowa, kościół św. Wojciecha (spoken: świętego Wojciecha), kościół Świętych Piotra i Pawła, kościół św. Andrzeja, ulica Kanonicza, Wawel, Wit Stwosz, Kazimierz Wielki, Zygmunt, Jan Długosz, Wisła, Droga Królewska.
  - Chinese: the stop names of `royal-route.json` (克拉科夫瓮城, 圣福里安门, 圣母圣殿, 纺织会馆, 亚当·米茨凯维奇纪念碑, 市政厅钟楼, 圣亚德伯堂, 圣伯多禄圣保禄堂, 圣安德肋教堂, 咏祷司铎街, 瓦维尔山) and established transliterations (克拉科夫, 维斯瓦河, 扬·马特伊科, 卡齐米日大帝, 齐格蒙特, 联合国教科文组织).
  - Saints in Polish are written out in speech ("świętego Floriana"), never abbreviated in the script.
- **Numbers.** Keep every number exactly as the English has it: digits stay digits (years), numbers written in words stay words. Never convert units or compute a new number. In Chinese, years are digits followed by 年; centuries are 世纪 with the same digits as the English ("15th century" = 15世纪).
- **Forbidden**, as for the English (validator spec v1, docs/ARCHITECTURE.md §7.4): URLs, markdown characters, hedges, and absolute directions in any language ("po lewej", "po prawej", "za tobą", 左边, 右边, 左侧, 右侧).
- **Length bands** (validator spec v1): pl teaser 15–60 words, full 120–420, deep ≤ 900, every sentence ≤ 45 words; zh teaser 40–150 CJK characters, full 300–1000, deep ≤ 2200, every sentence ≤ 110 characters.
- **Grounding.** The English claims carry over automatically. When a Polish proper noun is an inflected or local form that is not in those quotes (for example "Wita Stwosza" for Veit Stoss), add a claim in the translation file whose `quote` is an exact substring of the Polish source text that contains that form. Never add a claim for a fact the English does not state.

## Output format (`scripts/pack/review/<courseId>/<poiId>.<pl|zh>.md`)

```text
---
poiId: <poiId>
persona: historian
lang: pl | zh
generatedBy: mt          # machine translation by an AI agent; the app labels it "Machine-translated"
translatedFrom: en
promptId: translate-v1
model: claude-opus-5-5
translated: <YYYY-MM-DD>
sourceSha256: <scriptHash of the EN text it was translated from (node scripts/pack/review/check-drafts.mjs --hash <poiId>)>
reviewed:                # optional: a native speaker's "<initials> <YYYY-MM-DD>"; the pack tier follows the EN review
status: draft
---
## teaser
## full
## deep                  (only when the EN file has it)
## claims                (only extra local-language quotes; may be empty)
## view hint (translated)
look: <same as EN>
feature: <the EN feature, translated>
## translator notes
```

After writing, run `node scripts/pack/review/check-drafts.mjs` (every file must PASS and no translation may be STALE) and `scripts/pack/build-pack.sh`.
