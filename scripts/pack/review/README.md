# Historian review files (task B7)

> **HackYeah build:** these drafts were not human-reviewed; they ship as `grounded-ai` ("AI-drafted"). The steps below are for a later review.

One directory per course (`krakow/` = The Royal Route, `krakow-scholars/` = Scholars and Saints; scripts/pack/lib/course.mjs), and in it one file per tour stop and language: `<poiId>.en.md` (drafted by an AI agent with `prompts/historian-v1.md`), `<poiId>.pl.md` and `<poiId>.zh.md` (machine translations of the English by an AI agent with `prompts/translate-v1.md`). The pack build reads them with `scripts/pack/70-narrate.mjs`.

## Review an English file

1. Read the script against its claims and the cited source article; edit the text freely.
2. In the front matter, set `reviewed: <initials> <YYYY-MM-DD>` and `status: approved` (no change) or `status: edited` (you changed it).
3. Check and rebuild:

   ```bash
   node scripts/pack/review/check-drafts.mjs   # every file PASS; shows STALE translations
   node scripts/pack/70-narrate.mjs            # what the pack will contain: tier per file
   scripts/pack/build-pack.sh                  # rebuilds the pack (narrations/<lang>.json)
   ```

   All three default to the course `krakow`; add `--course <courseId>` for another course, e.g.

   ```bash
   node scripts/pack/review/check-drafts.mjs --course krakow-scholars
   scripts/pack/build-pack.sh --course krakow-scholars
   ```

Only a file with both lines filled becomes tier `reviewed` ("Historian script · reviewed · N sources" in the app). An unreviewed file ships as an AI draft (tier `grounded-ai`, labelled "AI-assisted"). A file whose `reviewed:` and `status:` disagree stops the build.

## After editing an EN file, ask an agent to refresh its pl/zh translation

The pl and zh files record `sourceSha256`, the hash of the English text they were translated from (`node scripts/pack/review/check-drafts.mjs [--course <courseId>] --hash <poiId>`). Approving an English file **without** changing its text keeps its translations fresh: they become `reviewed` too (still labelled "Machine-translated"). **Editing** the English text makes them STALE: `check-drafts.mjs` and the pack build print a warning, and the stale translations stay AI drafts (`grounded-ai`) until an agent re-translates them. Ask, for example: "refresh the pl/zh translation of poi_wd_Q1072350 with prompts/translate-v1.md". The build never translates by itself.
