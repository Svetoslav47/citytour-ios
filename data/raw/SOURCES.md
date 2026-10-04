# Raw data sources (`data/raw/`)

Snapshot retrieved: **2026-10-03 (UTC)**, from 12:06Z (OSM tiles) to 14:11Z (Wikipedia). Every file below was fetched once from the venue network and committed, so the pack build (task B2) and the app never touch the network. Overpass was down that day (docs/RISKS.md row x1), so POIs come from Wikidata SPARQL and the Kraków municipal ArcGIS, and the map from the OSM main API.

**Re-check or re-fetch.** Each source has one script in `scripts/pack/`. All use `scripts/pack/lib/http.mjs`: User-Agent `CityTour-HackYeah2026 (+https://github.com/Svetoslav47/citytour)`, 30 s timeout, 3 retries with exponential backoff, a per-host rate limit (OSRM and OSM 1 req/s, SPARQL 1 req/s, Wikipedia 5 req/s per language host, ArcGIS 4 req/s). JSON is written with sorted keys and gzipped when larger than 1 MB.

```bash
for s in scripts/pack/1*-fetch-*.mjs scripts/pack/[2-5]*-fetch-*.mjs; do node "$s" --offline || exit 1; done  # disk only: fails if a snapshot is missing
node scripts/pack/30-fetch-wiki.mjs            # fetches only missing snapshots (idempotent)
node scripts/pack/30-fetch-wiki.mjs --refresh  # re-fetches that source
node --test scripts/pack/*.test.mjs            # helper tests + snapshot sanity checks
```

Order matters on a fresh fetch: `30-fetch-wiki` reads the Wikidata snapshot, and `15-fetch-wikidata` and `50-fetch-osrm` read `data/tours/royal-route.json`.

## Summary

| Snapshot | Script | Source | Retrieved (UTC) | Records | Size on disk | Licence |
|---|---|---|---|---|---|---|
| `arcgis/pomnik.geojson` | 10 | Kraków ArcGIS `Pomnik` | 2026-10-03T13:24:08Z | 395 points | 368 KB | UNVERIFIED |
| `arcgis/zabytkowe-tablice-sim.geojson` | 10 | Kraków ArcGIS `Zabytkowe_tablice_SIM` | 2026-10-03T13:24:09Z | 923 points | 418 KB | UNVERIFIED |
| `arcgis/eoz-zabytki-zbiorcza-polygon.geojson.gz` | 10 | Kraków ArcGIS `EOZ_Zabytki___Warstwa_zbiorcza___AKTUALNA` layer 1 | 2026-10-03T13:24:17Z | 8,739 polygons | 2.1 MB (21 MB raw) | UNVERIFIED |
| `arcgis/eoz-zabytki-zbiorcza-line.geojson` | 10 | same service, layer 0 | 2026-10-03T13:24:11Z | 2 lines | 7 KB | UNVERIFIED |
| `arcgis/eoz-zabytki-archeologia-point.geojson` | 10 | Kraków ArcGIS `EOZ_Zabytki___Archeologia` layer 0 | 2026-10-03T13:24:20Z | 436 points | 640 KB | UNVERIFIED |
| `arcgis/eoz-zabytki-archeologia-polygon.geojson` | 10 | same service, layer 1 | 2026-10-03T13:24:21Z | 237 polygons | 592 KB | UNVERIFIED |
| `arcgis/otwarte-dane-eoz.geojson.gz` | 10 | Kraków ArcGIS `otwarte_dane_eoz` | 2026-10-03T13:24:25Z | 8,735 points | 594 KB (4.5 MB raw) | UNVERIFIED |
| `arcgis/unesco.geojson` | 10 | Kraków ArcGIS `UNESCO_4f365` | 2026-10-03T13:24:26Z | 2 polygons | 37 KB | UNVERIFIED |
| `arcgis/index.json` | 10 | layer list + the count-only duplicate service | 2026-10-03 | 8 layers + 1 | 3 KB | – |
| `wikidata/krakow-items.json.gz` | 15 | Wikidata Query Service (SPARQL) | 2026-10-03T13:44:06Z | 4,365 items | 200 KB (2.1 MB raw) | CC0 1.0 |
| `osm/oldtown-tile{1..9}.osm.gz` | 20 | OSM API 0.6 `map`, 3×3 tiles | 2026-10-03T12:06:48Z–12:07:10Z (gzip header times) | 110,296 nodes, 11,001 ways, 1,058 relations (summed over tiles; edges overlap) | 3.1 MB | ODbL 1.0 |
| `osm/kazimierz-tile{1..5}.osm.gz` | 20 | OSM API 0.6 `map`, 5 tiles south and east of the Old Town grid (course `krakow-kazimierz`) | 2026-10-03 21:28:58–21:29:04 UTC, gzip header times (not written in ISO form here on purpose: the `krakow` pack's `builtAt` is the newest ISO time in this file; see `tours/kazimierz/SOURCES.md`) | 44,113 nodes, 5,670 ways, 615 relations (summed over tiles) | 1.6 MB | ODbL 1.0 |
| `wiki/summaries-en.json` | 30 | en.wikipedia.org REST page summary | 2026-10-03T14:01:44Z | 229 pages | 140 KB | CC BY-SA 4.0 |
| `wiki/summaries-pl.json` | 30 | pl.wikipedia.org REST page summary | 2026-10-03T14:09:56Z | 310 pages | 183 KB | CC BY-SA 4.0 |
| `wiki/summaries-zh.json` | 30 | zh.wikipedia.org REST page summary (zh-hans) | 2026-10-03T14:10:53Z | 82 pages | 51 KB | CC BY-SA 4.0 |
| `wiki/stops-text-en.json` | 30 | en.wikipedia.org action API `extracts` | 2026-10-03T14:10:58Z | 11 stop articles, 473–5,328 chars | 41 KB | CC BY-SA 4.0 |
| `wiki/stops-text-pl.json` | 30 | pl.wikipedia.org action API `extracts` | 2026-10-03T14:11:03Z | 11 stop articles, 2,077–5,998 chars | 51 KB | CC BY-SA 4.0 |
| `wiki/stops-text-zh.json` | 30 | zh.wikipedia.org action API `extracts` (zh-hans) | 2026-10-03T14:11:07Z | 11 stop articles, 113–715 chars | 13 KB | CC BY-SA 4.0 |
| `osrm/stops-table-foot.json` | 50 | OSRM foot `table` | 2026-10-03T13:28:04Z | 11×11 durations + distances | 7 KB | ODbL 1.0 (derived from OSM) |
| `osrm/stop-pairs-foot.json.gz` | 50 | OSRM foot `route`, every directed stop pair | 2026-10-03T13:42:11Z (last route) | 110 routes with steps | 137 KB (2.9 MB raw) | ODbL 1.0 (derived from OSM) |
| `osrm/royal-route-foot.json` | (lead, by hand) | OSRM foot `route` through the 11 map-meta pins in listed order | 2026-10-03 (time not recorded) | 1 route, 10 legs: 2,497 m / 33 min | 8 KB | ODbL 1.0 (derived from OSM) |

Total: `du -sh data/raw` = 8.7 MB (budget 25 MB).

**Gate G4 status:** every source is present. The fallback (tour stops + the 395 ArcGIS monuments + haversine × 1.3) is **not needed**. Note for that fallback anyway: the `Pomnik` points carry no names (below).

## 1. Kraków municipal ArcGIS (`10-fetch-arcgis.mjs`)

- **Publisher:** the ArcGIS Online organisation "Zintegrowana Platforma GIS - Gmina Miejska Kraków" (`gmk-2.maps.arcgis.com`, org id `svTzSt3AvH7sK6q9`), the City of Kraków's integrated GIS platform.
- **Services directory:** `https://services-eu1.arcgis.com/svTzSt3AvH7sK6q9/ArcGIS/rest/services` (390 services). Found through the ArcGIS Online search API (`https://www.arcgis.com/sharing/rest/search?q=Zabytkowe_tablice_SIM&f=json`, `q=EOZ_Zabytki`), which returned the items of this org.
- **Query:** `<layer>/query?where=1=1&outFields=*&f=geojson&outSR=4326&geometryPrecision=6&orderByFields=<oid> ASC&resultRecordCount=1000&resultOffset=<paged>`. Coordinates are rounded to 6 decimals (about 0.1 m). The script checks that the number of features equals `returnCountOnly`.

| Layer file | Feature service (`…/rest/services/<name>/FeatureServer/<n>`) | Item (owner, last modified) |
|---|---|---|
| `pomnik` | `Pomnik/FeatureServer/0` | `03cc6f12b6104034a3f169e71165a8cb` (kozielskam, 2025-02-07) |
| `zabytkowe-tablice-sim` | `Zabytkowe_tablice_SIM/FeatureServer/0` (layer name `inwentaryzacja_ulicowki_`) | `2701a1e22dde42f0bf3020925c4755d2` (spytkowskig_1, 2025-08-28) |
| `eoz-zabytki-zbiorcza-line` / `-polygon` | `EOZ_Zabytki___Warstwa_zbiorcza___AKTUALNA/FeatureServer/0` and `/1` | `3c59629fc92b4925a59b7da5446782c3` (kozielskam, 2023-08-30) |
| `eoz-zabytki-archeologia-point` / `-polygon` | `EOZ_Zabytki___Archeologia/FeatureServer/0` and `/1` | `8506d274978b4cddbcf28dd5c22770e6` (wozniakm2, 2023-11-16) |
| `otwarte-dane-eoz` | `otwarte_dane_eoz/FeatureServer/0` | `c8464275e6154c6faa7d645a06f42daf` (kozielskam, 2023-11-16) |
| `unesco` | `UNESCO_4f365/FeatureServer/0` | `cfd6ed0d7f7842b193341f28c0b1cc7b` (wozniakm2, 2023-11-18) |
| (counted, not downloaded) | `EOZ_Zabytki___Archeologia__2_/FeatureServer/0` and `/1`: 436 + 237 | `96212186d4b9401790f17d814f4b3dd7` (kozielskam): same layer names, fields and counts as `EOZ_Zabytki___Archeologia`, treated as a copy |

Prefix every service path with `https://services-eu1.arcgis.com/svTzSt3AvH7sK6q9/ArcGIS/rest/services/`. Item pages: `https://www.arcgis.com/home/item.html?id=<item>`.

**Licence: UNVERIFIED.** None of these items, nor the organisation's portal record, publishes `licenseInfo`, `accessInformation` or terms of use (checked on 2026-10-03 through `https://www.arcgis.com/sharing/rest/content/items/<id>?f=json` and `…/portals/svTzSt3AvH7sK6q9?f=json`). The items are public. Until the terms are confirmed, follow docs/RISKS.md T14: use the data for coordinates and register facts, and cite "City of Kraków (Gmina Miejska Kraków), Zintegrowana Platforma GIS" with the service URL and retrieval date.

**What the layers contain (read before merging):**
- `Pomnik`: monuments as surveyed points of the city base map (`KOD_NZ = "Pomnik"`, district in `JE_NAZWA`). **No name attribute**: only 2 of 395 points carry a `REMARKS` note naming the monument.
- `Zabytkowe_tablice_SIM`: an inventory of **historic enamel street-name signs** (`typ` = enamel colour, `panel_1..5` = the text on the sign, mostly a street name; all `zabytkowa = "tak"`). These are not memorial plaques.
- `EOZ_Zabytki_*` and `otwarte_dane_eoz`: the municipal register of historic buildings and sites (gminna ewidencja zabytków). Useful fields: `NAZWA` (name; 4,690 of the 8,735 open-data points have one), `ADRES`, `DZIELNICA`, `NUMER_REJ_` (state register number; 2,022 points have one), `WIEK_POWST` / `WIEK_CZ_PO` (dating, free text), `STYL_OBIEK`. `otwarte_dane_eoz` is the open-data point view of the same register with a slim schema; the combined layer adds polygons and more attributes.
- `UNESCO_4f365`: two polygons, `"Granice obszaru UNESCO"` (the World Heritage property, Historic Centre of Kraków) and `"Granice strefy buforowej"` (its buffer zone).

## 2. Wikidata (`15-fetch-wikidata.mjs`)

- **Endpoint:** `https://query.wikidata.org/sparql` (POST, `format=json`). The exact queries are stored in the snapshot's `meta.queries`.
- **Scope:** items with coordinates (P625) located in Kraków, `?item wdt:P131* wd:Q31487` (districts count). Tour stops outside that set would be added by QID; all 11 are inside it. 4,365 items, of which 5 have coordinates outside the city box (lat 49.97–50.13, lng 19.79–20.22), e.g. artworks with the coordinates of their origin. The snapshot keeps them; the pack build filters by bbox.
- **Per item:** `lat`/`lng` (first of the sorted best-rank coordinates; others in `otherCoords`), `sitelinks`, `labels` en/pl/zh (zh = zh-hans, else zh-cn, else zh; `zhLabelFrom` says which), `wikipedia` en/pl/zh article titles, `instanceOf` (P31), `heritage` (P1435), `architects` (P84), `styles` (P149), `inception` (P571 with precision: 9 year, 8 decade, 7 century). `valueLabels` holds en/pl/zh labels for the 682 QIDs used in those properties.
- **Coverage:** labels en 2,366 / pl 4,318 / zh 121; Wikipedia articles en 348 / pl 2,593 / zh 83; heritage designation 2,241; inception 2,042; architect 238; style 237.
- **Why several queries:** one query with labels, sitelinks and a `UNION` for the tour stops took 20 s (close to the 30 s client timeout, and it timed out on the venue network); split per concern without the union, each takes about 3 s.
- **Licence:** CC0 1.0. No attribution required; credit "Wikidata" anyway.

## 3. OpenStreetMap map tiles (`20-fetch-osm-tiles.mjs`)

- **Endpoint:** `https://api.openstreetmap.org/api/0.6/map?bbox=<minLon>,<minLat>,<maxLon>,<maxLat>` (the API caps one call at 50,000 nodes).
- **Tiling:** the Old Town bbox lon 19.9290–19.9470, lat 50.0525–50.0675 in a 3×3 grid of 0.006° lon × 0.005° lat tiles, numbered row-major from the south-west: rows at lat 50.0525 / 50.0575 / 50.0625, columns at lon 19.9290 / 19.9350 / 19.9410. Tile 1 = `19.9290,50.0525,19.9350,50.0575`; tile 9 = `19.9410,50.0625,19.9470,50.0675`.
- **Fetched by the lead** at 2026-10-03 12:06:48Z–12:07:10Z (the gzip header times); the newest edit inside the tiles is 2026-10-03T07:50:52Z. The script reproduces the tiling, checks every file's `<bounds>` and only fetches missing tiles. Its online path was tested once by re-fetching tile 9 into a temporary location (same node/way/relation counts); the lead's file was kept.

| Tile | bbox (minLon,minLat,maxLon,maxLat) | Nodes | Ways | Relations | Size |
|---|---|---|---|---|---|
| 1 | 19.929,50.0525,19.935,50.0575 | 9,129 | 844 | 177 | 368 KB |
| 2 | 19.935,50.0525,19.941,50.0575 | 12,308 | 1,327 | 145 | 327 KB |
| 3 | 19.941,50.0525,19.947,50.0575 | 12,219 | 1,440 | 84 | 308 KB |
| 4 | 19.929,50.0575,19.935,50.0625 | 11,027 | 928 | 79 | 289 KB |
| 5 | 19.935,50.0575,19.941,50.0625 | 15,365 | 1,352 | 106 | 423 KB |
| 6 | 19.941,50.0575,19.947,50.0625 | 13,303 | 1,239 | 123 | 346 KB |
| 7 | 19.929,50.0625,19.935,50.0675 | 9,241 | 1,098 | 62 | 269 KB |
| 8 | 19.935,50.0625,19.941,50.0675 | 13,275 | 1,201 | 102 | 377 KB |
| 9 | 19.941,50.0625,19.947,50.0675 | 14,429 | 1,572 | 180 | 436 KB |

**Kazimierz extension** (course `krakow-kazimierz`, docs/research/new-tours.md §4.1): five more tiles on the same grid, fetched by a Claude Code agent with `node scripts/pack/20-fetch-osm-tiles.mjs` on 2026-10-03 between 21:28:58 and 21:29:04 UTC (written into the gzip headers, like the lead's tiles; the newest edit inside is 2026-10-03 20:46 UTC). Retrieval times and the other per-tour snapshots: [`tours/kazimierz/SOURCES.md`](tours/kazimierz/SOURCES.md). The Kazimierz map (`MAP_AREAS.kazimierz` in `60-mapdata.mjs`) is Old Town tiles 1–3 plus these five: lon 19.929–19.953, lat 50.0475–50.0575.

| Tile | bbox (minLon,minLat,maxLon,maxLat) | Nodes | Ways | Relations | Size |
|---|---|---|---|---|---|
| kazimierz-tile1 | 19.929,50.0475,19.935,50.0525 | 6,603 | 854 | 188 | 330 KB |
| kazimierz-tile2 | 19.935,50.0475,19.941,50.0525 | 9,431 | 1,015 | 99 | 264 KB |
| kazimierz-tile3 | 19.941,50.0475,19.947,50.0525 | 12,173 | 1,686 | 77 | 341 KB |
| kazimierz-tile4 | 19.947,50.0475,19.953,50.0525 | 9,444 | 1,170 | 127 | 348 KB |
| kazimierz-tile5 | 19.947,50.0525,19.953,50.0575 | 6,462 | 945 | 124 | 302 KB |

Tiles overlap at their edges (ways crossing a border appear in both), so deduplicate by element id when merging.

- **Licence:** ODbL 1.0, "© OpenStreetMap contributors". Required on the map and in About; the derived pack is a derived database (docs/RISKS.md T14).

## 4. Wikipedia (`30-fetch-wiki.mjs`)

- **Selection:** the 11 tour stops, then the top 300 other Wikidata items by sitelink count (ties: lower QID), excluding the city item Q31487 and items outside the city box. That is 311 items; a page is fetched for each language in which the item has an article (titles from the Wikidata snapshot). No page was missing (`meta.missing` is empty in all six files).
- **Summaries** (`summaries-{en,pl,zh}.json`): `https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}`, zh with `Accept-Language: zh-hans`. Stored as `pages[QID] = { title, description, extract, type, url, pageid, revision, timestamp }`, plus `requestedTitle` when the Wikidata title redirected (en: "Wawel" → "Wawel Castle", "Bastion III "Kleparz"" → "Kraków Fortress"; pl: one redirect).
- **Stop texts** (`stops-text-{en,pl,zh}.json`): `https://{lang}.wikipedia.org/w/api.php?action=query&prop=extracts|revisions|info&explaintext=1&exsectionformat=wiki&rvprop=ids|timestamp&inprop=url&redirects=1&format=json&formatversion=2&titles={title}`, zh with `variant=zh-hans` (without it the zh text mixes in traditional characters). `exintro` is deliberately absent: MediaWiki treats any value, even `0`, as true and would return only the lead. The whole article is kept as plain text with `== Heading ==` lines, trailing link/reference sections are dropped, and the text is capped at 6,000 chars on a paragraph or sentence end (`truncated`, `fullChars`). Stored as `pages[QID] = { title, pageid, revid, timestamp, url, text, chars, fullChars, truncated }`. These are the only texts task B7 may draft narrations from.
- **Caveats for B7:** the en text for Wawel (Q743704) is the "Wawel Castle" article (redirect). The zh articles are short (113–715 chars), so zh narrations will mostly be translations. The en Kanonicza Street article is short (473 chars); the pl one is long (truncated from 15,447 chars).

- **Licence:** CC BY-SA 4.0, "Wikipedia contributors". Any narration adapted from these texts must be credited with the article title, a link and "Wikipedia contributors", and shared alike (docs/RISKS.md T14). The revision ids identify the exact text used.

## 5. OSRM foot routing (`50-fetch-osrm.mjs`)

- **Server:** the FOSSGIS OSRM demo `https://routing.openstreetmap.de/routed-foot` (fair use; 1 req/s; 111 requests in total).
- **Stops:** the 11 stops of `data/tours/royal-route.json` at their tour coordinates, recorded in each snapshot's `meta.stops`. The script refuses to reuse a snapshot taken for other coordinates.
- `stops-table-foot.json`: `table/v1/foot/{11 coords}?annotations=duration,distance`. `response.sources[i].distance` is how far stop *i* had to be moved to the nearest walkable way (0–28 m).
- `stop-pairs-foot.json.gz`: `route/v1/foot/{from};{to}?overview=full&geometries=geojson&steps=true` for all 110 directed pairs, as `routes[] = { from, to, i, j, response }`. Waypoint `hint`s are removed (opaque server ids).
- **Listed order** (stop *i* to *i+1* from the pair routes): **2,048 m, 27.4 min**. The lead's `royal-route-foot.json` says 2,497 m / 33 min because it routed between the map-meta pins, which sit on the walking network, while the tour uses the buildings' coordinates. Task A5 bootstraps the demo walk from the lead's file, which is unchanged.
- **Licence:** routes are derived from OSM data: ODbL 1.0, "© OpenStreetMap contributors".

## 6. Curated tour (`data/tours/royal-route.json`, not fetched)

Hand-curated by the agent and **not yet confirmed by a human** (`coordinatesConfirmedBy: null`, every view hint `"review": "to review"`). Coordinates are Wikidata P625 except Kanonicza Street (length-midpoint of its OSM ways, 5.5 m from P625). Each stop records its distance to the map-meta pin, to the OSM element with the same QID and its OSRM snap distance; five stops are more than 40 m from their map-meta pin and each has a note explaining why. Each view hint cites the sentence in `wiki/stops-text-*.json` that supports it (`view.basis`).
