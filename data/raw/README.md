# Raw data snapshots

Fetched once on 2026-10-03 and committed, so the app's build never needs the network.

**See [`SOURCES.md`](SOURCES.md)** for every snapshot: endpoint and query, retrieval time (UTC), record counts, sizes and licences (OSM ODbL 1.0, Wikipedia CC BY-SA 4.0, Wikidata CC0, Kraków municipal ArcGIS: licence UNVERIFIED), plus how to re-check them offline with the `scripts/pack/*-fetch-*.mjs` scripts.

| Folder | Content | Script |
|---|---|---|
| `arcgis/` | Kraków municipal GIS layers: monuments, heritage register (EOZ), historic street signs, UNESCO zone | `scripts/pack/10-fetch-arcgis.mjs` |
| `wikidata/` | 4,365 Wikidata items located in Kraków (coordinates, labels en/pl/zh, sitelinks, heritage, inception, architect, style) | `scripts/pack/15-fetch-wikidata.mjs` |
| `osm/` | Old Town map data, OSM API in 3×3 bbox tiles (Overpass was down) | `scripts/pack/20-fetch-osm-tiles.mjs` |
| `wiki/` | Wikipedia summaries en/pl/zh (tour stops + top 300 places) and the fuller stop article texts | `scripts/pack/30-fetch-wiki.mjs` |
| `osrm/` | OSRM foot routing: stop matrix, all 110 stop-pair routes, and the lead's listed-order route | `scripts/pack/50-fetch-osrm.mjs` |
