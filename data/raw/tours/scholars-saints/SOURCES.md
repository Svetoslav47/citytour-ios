# Raw data of the Scholars and Saints tour (`data/raw/tours/scholars-saints/`)

Per-tour snapshots of the course `krakow-scholars` (tour `data/tours/scholars-saints.json`, docs/research/new-tours.md §3). Everything else the pack build reads is shared with the other courses and documented in `data/raw/SOURCES.md` (Wikidata items, Wikipedia summaries, OSM tiles, ArcGIS layers). The pack build (`scripts/pack/build-pack.sh --course krakow-scholars`) counts the retrieval times below for the pack's `builtAt`.

Fetched with the same scripts, User-Agent, timeouts, retries and rate limits as the shared snapshots:

```bash
node scripts/pack/30-fetch-wiki.mjs --course krakow-scholars   # wiki/stops-text-{en,pl,zh}.json (summaries: kept, shared)
node scripts/pack/50-fetch-osrm.mjs --course krakow-scholars   # osrm/stops-table-foot.json + osrm/stop-pairs-foot.json.gz
node scripts/pack/30-fetch-wiki.mjs --course krakow-scholars --offline && node scripts/pack/50-fetch-osrm.mjs --course krakow-scholars --offline   # disk only
```

| Snapshot | Script | Source | Retrieved (UTC) | Records | Licence |
|---|---|---|---|---|---|
| `wiki/stops-text-en.json` | 30 | en.wikipedia.org action API `extracts` | 2026-10-03T21:24:36Z | 9 stop articles, 277–4,684 chars (Collegium Iuridicum has no en article) | CC BY-SA 4.0 |
| `wiki/stops-text-pl.json` | 30 | pl.wikipedia.org action API `extracts` | 2026-10-03T21:24:40Z | 10 stop articles, 2,171–5,831 chars | CC BY-SA 4.0 |
| `wiki/stops-text-zh.json` | 30 | zh.wikipedia.org action API `extracts` (zh-hans) | 2026-10-03T21:24:42Z | 6 stop articles, 71–300 chars (no zh article for Collegium Novum, St Joseph, Collegium Iuridicum, Nowodworski School) | CC BY-SA 4.0 |
| `osrm/stops-table-foot.json` | 50 | OSRM foot `table` (routing.openstreetmap.de/routed-foot) | 2026-10-03T21:25:09Z | 10×10 durations + distances | ODbL 1.0 (derived from OSM) |
| `osrm/stop-pairs-foot.json.gz` | 50 | OSRM foot `route`, every directed stop pair | 2026-10-03T21:26:39Z (last route) | 90 routes with steps | ODbL 1.0 (derived from OSM) |

OSRM listed order (Collegium Novum → … → Nowodworski School): **2,242 m, 29.9 min** walking. Snap distance per stop: 22.6, 5.5, 1.7, 9.5, 2.5, 8.1, 22.6, 23.7, 14.3, 11.8 m (all below the 35 m trigger radius).

The stop coordinates are Wikidata P625 from the shared snapshot `data/raw/wikidata/krakow-items.json.gz`; each was cross-checked against the OSM element tagged with the same `wikidata=` in the shared tiles `data/raw/osm/oldtown-tile*.osm.gz` (`coordinateCheck` in the tour file).
