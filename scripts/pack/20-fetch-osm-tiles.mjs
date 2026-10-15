#!/usr/bin/env node
// Stage 3: OpenStreetMap map data for the Old Town -> data/raw/osm/oldtown-tile{1..9}.osm.gz
//
// Overpass was down on 2026-10-03, so the map comes from the OSM main API `map` call, which caps a
// request at 50,000 nodes; the Old Town bbox lon 19.9290-19.9470, lat 50.0525-50.0675 is split
// into a 3x3 grid of 0.006 deg lon x 0.005 deg lat tiles, numbered row-major from the south-west.
// The lead fetched these tiles first (gzip header times 2026-10-03 12:06-12:07 UTC); this script
// reproduces exactly that tiling and file naming, verifies each file's <bounds>, and only fetches
// tiles that are missing (or all of them with --refresh).
//
// Kazimierz course (krakow-kazimierz): five more tiles on the same grid extend the map south and east over
// Kazimierz, Skałka and the Vistula bank: the row below the Old Town (lat 50.0475-50.0525, lon 19.929-19.953,
// four tiles) and one tile east of tile 3 (lat 50.0525-50.0575, lon 19.947-19.953), saved as
// osm/kazimierz-tile{1..5}.osm.gz (west to east, then the north-east tile). The Old Town tiles are unchanged.
//
// Usage: node scripts/pack/20-fetch-osm-tiles.mjs [--offline | --refresh]   (both tile sets)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHttp, fmtBytes, isMain, MissingSnapshotError, rawPath, runMain } from './lib/http.mjs';

export const OSM_MAP_API = 'https://api.openstreetmap.org/api/0.6/map';
export const ORIGIN = { lon: 19.929, lat: 50.0525 };
export const STEP = { lon: 0.006, lat: 0.005 };
export const GRID = 3;

/** The 9 tiles: n = 1..9 row-major from the south-west, bbox as [minLon, minLat, maxLon, maxLat]. */
export function tiles() {
  const out = [];
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const minLon = round4(ORIGIN.lon + col * STEP.lon);
      const minLat = round4(ORIGIN.lat + row * STEP.lat);
      const bbox = [minLon, minLat, round4(minLon + STEP.lon), round4(minLat + STEP.lat)];
      const n = row * GRID + col + 1;
      out.push({ n, rel: `osm/oldtown-tile${n}.osm.gz`, bbox });
    }
  }
  return out;
}

/** Grid cells (col, row) of the Kazimierz extension, on the Old Town grid (row -1 = south of tile 1). */
export const KAZIMIERZ_CELLS = Object.freeze([[0, -1], [1, -1], [2, -1], [3, -1], [3, 0]]);

/** The 5 Kazimierz tiles, n = 1..5 in KAZIMIERZ_CELLS order. */
export function kazimierzTiles() {
  return KAZIMIERZ_CELLS.map(([col, row], i) => {
    const minLon = round4(ORIGIN.lon + col * STEP.lon);
    const minLat = round4(ORIGIN.lat + row * STEP.lat);
    return { n: i + 1, rel: `osm/kazimierz-tile${i + 1}.osm.gz`, bbox: [minLon, minLat, round4(minLon + STEP.lon), round4(minLat + STEP.lat)] };
  });
}

/** Every tile the map builds use: the Old Town 3x3 grid, then the Kazimierz extension. */
export function allTiles() {
  return [...tiles(), ...kazimierzTiles()];
}

function round4(x) {
  return Math.round(x * 1e4) / 1e4;
}

/**
 * gzip with the fetch time in the header MTIME field (seconds, UTC), like the lead's Old Town tiles: the pack build
 * reads it as the map's retrieval time (90-emit.mjs gzipMtimeIso). Node's gzipSync writes 0 there.
 */
export function gzipWithMtime(buf, ms) {
  const gz = gzipSync(buf, { level: 9 });
  gz.writeUInt32LE(Math.floor(ms / 1000), 4);
  return gz;
}

export function tileUrl(bbox) {
  return `${OSM_MAP_API}?bbox=${bbox.map((v) => v.toFixed(4)).join(',')}`;
}

/** Reads the <bounds> element of an OSM XML document as [minLon, minLat, maxLon, maxLat]. */
export function parseBounds(xml) {
  const m = /<bounds\s+minlat="([\d.-]+)"\s+minlon="([\d.-]+)"\s+maxlat="([\d.-]+)"\s+maxlon="([\d.-]+)"/.exec(xml);
  return m ? [Number(m[2]), Number(m[1]), Number(m[4]), Number(m[3])] : null;
}

export function sameBbox(a, b) {
  return Boolean(a && b) && a.every((v, i) => Math.abs(v - b[i]) < 1e-7);
}

export function osmStats(xml) {
  const count = (re) => (xml.match(re) || []).length;
  const ts = xml.match(/timestamp="[^"]+"/g) || [];
  const newest = ts.reduce((m, t) => (t > m ? t : m), '').slice(11, -1) || null;
  return { nodes: count(/<node /g), ways: count(/<way /g), relations: count(/<relation /g), newestEdit: newest };
}

async function main(args) {
  const http = createHttp();
  for (const t of allTiles()) {
    const p = rawPath(t.rel);
    if (existsSync(p) && !args.refresh) {
      const xml = gunzipSync(readFileSync(p)).toString('utf8');
      const b = parseBounds(xml);
      if (!sameBbox(b, t.bbox)) throw new Error(`data/raw/${t.rel}: <bounds> ${JSON.stringify(b)} != expected ${JSON.stringify(t.bbox)}`);
      const s = osmStats(xml);
      console.log(`osm ${t.rel} keep  bbox=${t.bbox.join(',')} ${fmtBytes(readFileSync(p).length)} nodes=${s.nodes} ways=${s.ways} relations=${s.relations} newestEdit=${s.newestEdit}`);
      continue;
    }
    if (args.offline) throw new MissingSnapshotError(t.rel);
    const body = await http.getBuffer(tileUrl(t.bbox), { Accept: 'application/xml' });
    const xml = body.toString('utf8');
    if (!sameBbox(parseBounds(xml), t.bbox)) throw new Error(`tile${t.n}: response has no matching <bounds> (got ${xml.slice(0, 200)})`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, gzipWithMtime(body, Date.now()));
    const s = osmStats(xml);
    console.log(`osm ${t.rel} wrote bbox=${t.bbox.join(',')} ${fmtBytes(readFileSync(p).length)} nodes=${s.nodes} ways=${s.ways} relations=${s.relations}`);
  }
}

if (isMain(import.meta.url)) runMain(main);
