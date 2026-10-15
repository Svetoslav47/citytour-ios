#!/usr/bin/env bash
# Builds the offline pack of one course (task B2) into data/course/<courseId>/packs/<courseId>/
# (the app ships no course: the server publishes this folder and the app downloads it).
# Default course: krakow (The Royal Route, data/tours/royal-route.json). Other courses: --course <courseId> or
# --tour <tourId> (data/tours/<tourId>.json names its courseId; see scripts/pack/lib/course.mjs).
#
# Reads only committed inputs (data/raw/**, data/tours/<tourId>.json); the network is disabled inside the
# build (scripts/pack/90-emit.mjs). Deterministic: running it twice gives byte-identical files (no clock, stable
# sorts, fixed number formatting). The fetch scripts (scripts/pack/*-fetch-*.mjs, task B1) are NOT run here;
# re-fetching raw data is a separate, deliberate step (data/raw/SOURCES.md).
#
# Afterwards (unless --out is given) it re-runs scripts/pack/split-city.mjs, which regenerates the city packs
# (data/city/<cityId>/) and the course overlays (data/course/<id>/tour/) from the committed full packs: well under a
# second, deterministic, and it only writes files whose bytes change.
#
# Usage: scripts/pack/build-pack.sh [--course <courseId> | --tour <tourId>] [--out DIR]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error(`build-pack: Node 22+ required, found ${process.version}`); process.exit(1); }'
node scripts/pack/90-emit.mjs "$@"
case " $* " in
  *" --out "*) echo "build-pack: --out given, city packs and course overlays not refreshed" ;;
  *) node scripts/pack/split-city.mjs ;;
esac
