# Raw data of the Kazimierz tour (course `krakow-kazimierz`)

Per-tour snapshots of `data/tours/kazimierz.json` (scripts/pack/lib/course.mjs). Everything else (Wikidata, wiki summaries, ArcGIS) is shared with the other courses and documented in [`../../SOURCES.md`](../../SOURCES.md). Fetched by a Claude Code agent on 2026-10-03 with the scripts below; the retrieval times in this file count for the `krakow-kazimierz` pack's `builtAt` (90-emit.mjs), not for the `krakow` pack.

```bash
node scripts/pack/20-fetch-osm-tiles.mjs --offline                     # the 9 Old Town + 5 Kazimierz tiles are on disk
node scripts/pack/30-fetch-wiki.mjs --course krakow-kazimierz --offline
node scripts/pack/50-fetch-osrm.mjs --course krakow-kazimierz --offline
```

| Snapshot | Script | Source | Retrieved (UTC) | Records | Licence |
|---|---|---|---|---|---|
| `wiki/stops-text-en.json` | 30 | en.wikipedia.org action API `extracts` | 2026-10-03T21:28:16Z | 12 articles (10 stops + `sourceQids` Q194616 Ethnographic Museum, Q115001 Remah Cemetery, Q9366047 Szeroka Street), 410–4,252 chars; no en article for the Town Hall (Q15880176) and Plac Nowy (Q11008519) | CC BY-SA 4.0 |
| `wiki/stops-text-pl.json` | 30 | pl.wikipedia.org action API `extracts` | 2026-10-03T21:28:21Z | 14 articles (11 stops + 3 `sourceQids`), 1,863–5,981 chars | CC BY-SA 4.0 |
| `wiki/stops-text-zh.json` | 30 | zh.wikipedia.org action API `extracts` (zh-hans) | 2026-10-03T21:28:24Z | 9 articles, 68–757 chars | CC BY-SA 4.0 |
| `osrm/stops-table-foot.json` | 50 | OSRM foot `table`, 11 × 11 | 2026-10-03T21:28:34Z | snap distances 7.5–32.9 m | ODbL 1.0 (derived from OSM) |
| `osrm/stop-pairs-foot.json.gz` | 50 | OSRM foot `route`, all 110 directed stop pairs | 2026-10-03T21:30:23Z (last route) | listed order 2,151 m, 28.8 min | ODbL 1.0 (derived from OSM) |
| `../../osm/kazimierz-tile{1..5}.osm.gz` | 20 | OSM API 0.6 `map`, five tiles south and east of the Old Town grid | 2026-10-03T21:28:58Z–21:29:04Z (gzip header times) | 44,113 nodes, 5,670 ways, 615 relations (summed over tiles) | ODbL 1.0 |

- **Wikipedia stop texts:** same processing as the Royal Route (`../../SOURCES.md` §4): whole article as plain text with `== Heading ==` lines, trailing reference sections dropped, capped at 6,000 chars. The en Remah Synagogue article is truncated (4,252 of 6,513 chars); the pl articles of Skałka, St Catherine, Corpus Christi, Tempel, Kupa, Izaak, Remuh and the Old Synagogue too. The en St Catherine article is a stub (410 chars): its story is grounded on the pl article.
- **Map:** the course map (`MAP_AREAS.kazimierz` in `scripts/pack/60-mapdata.mjs`) is Old Town tiles 1–3 (lead's fetch, 12:06Z) plus the five Kazimierz tiles: lon 19.929–19.953, lat 50.0475–50.0575, which holds all 11 stops (lat 50.0483–50.0529, lng 19.9378–19.9488) and Wawel.
- **OSRM:** FOSSGIS demo server `https://routing.openstreetmap.de/routed-foot`, 1 req/s, 111 requests. Legs in listed order: 268, 261, 279, 302, 201, 177, 196, 152, 179, 137 m.
