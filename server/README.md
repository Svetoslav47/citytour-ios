# CityTour course server

Express + TypeScript (Node 22, ESM, strict) implementation of [`docs/SERVER.md`](../docs/SERVER.md): a signed
course catalog and manifests, content-addressed blobs (pack JSONs and the pre-rendered ElevenLabs clips), and
`POST /v1/tts`, which renders **only** the course's allowed lines in the studio voice and caches them forever.
The app works without this server; it is an optional download and voice upgrade.

```
GET  /healthz                         {ok, version}
POST /v1/installs                     {token, expiresAt}          (rate-limited per IP)
GET  /v1/catalog                      {payload:{courses, cities}, sig}    (Ed25519, canonical JSON)
GET  /v1/courses/:courseId/manifest   {payload:CourseManifest, sig}
GET  /v1/cities/:cityId/manifest      {payload:CityManifest, sig}
GET  /v1/blobs/:sha256                bytes, immutable, ETag
POST /v1/tts                          audio/mpeg, X-Text-Sha256, X-Cache: hit|miss   (Bearer token)
```

## Run locally

```bash
cd server
npm ci
npm run keygen                      # Ed25519 keypair -> server/.keys/ (gitignored); prints the PUBLIC key
# the city pack first, then its courses (the app ships no course; it downloads these)
npm run publish-city -- --city krakow --pack ../data/city/krakow --data ./data --seed ./seed
for c in krakow krakow-scholars krakow-kazimierz; do
  npm run publish-course -- --course $c --pack ../data/course/$c/tour --audio ../data/course/$c/audio \
    --city-id krakow --data ./data --seed ./seed
done
cp .env.example .env                # then set TOKEN_SECRET (openssl rand -base64 48); a dummy ElevenLabs key is fine
npm run dev                         # or: npm run build && node --env-file=.env dist/server.js
npm run smoke -- http://127.0.0.1:8080 .keys/signing-public.pem
```

`npm run smoke` checks healthz, both signatures, one blob's sha256, path traversal, an install token, a TTS
request for a line that has a shipped clip (must be `X-Cache: hit`, no credits) and a disallowed line (403).
It never calls ElevenLabs.

To guarantee no ElevenLabs call at all while developing, also set `ELEVENLABS_BASE_URL=http://127.0.0.1:9`:
cache hits still work and every miss is a 502 (the app falls back).

Other scripts: `npm test` (vitest + supertest; ElevenLabs is always mocked), `npm run typecheck`, `npm run lint`
(tsc), `npm run build`, `npm start`.

## Environment

Validated with zod at boot; the process exits with a list of the bad variables (values are never printed).

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | required | Data directory (`docs/SERVER.md` §5). Docker/Render: `/var/data`. |
| `TOKEN_SECRET` | required, 32+ chars | Signs install tokens (HMAC-SHA256). `openssl rand -base64 48`. |
| `ELEVENLABS_API_KEY` | required | ElevenLabs key. Only in the environment. An exhausted or invalid key is fine: the breaker opens, `/v1/tts` answers 503 and the app falls back; courses and cached lines keep working. |
| `ELEVENLABS_VOICE_ID` | `JBFqnCBsd6RMkjVDRZzb` (George) | Voice. |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` | Model (output `mp3_22050_32`, same voice settings as `scripts/voice/render-elevenlabs.mjs`). |
| `ELEVENLABS_BASE_URL` | `https://api.elevenlabs.io` | Override for tests / offline dev. |
| `TTS_DAILY_CHAR_BUDGET` | `20000` | Characters per UTC day; then 429 `budget`. `0` disables rendering (cache only). |
| `TTS_TIMEOUT_MS` | `10000` | Upstream timeout (AbortController). |
| `TRUST_PROXY` | `false` | Express `trust proxy`: `false`, `true`, a hop count (Render: `1`) or a subnet list. Needed so rate limits see the real client IP. |
| `RATE_INSTALLS_PER_HOUR` | `20` | Per IP. |
| `RATE_TTS_PER_10MIN` | `300` | Per install token + IP. |
| `SEED_DIR`, `SEED_FILES_DIR`, `SEED_CITY_FILES_DIR` | unset (Docker: `/app/seed`, `/app/seed-files`, `/app/seed-city-files`) | Boot-time seeding, see below. |
| `HOST`, `PORT`, `LOG_LEVEL` | `0.0.0.0`, `8080`, `info` | |
| `SIGNING_PRIVATE_KEY` | - | **Only for `publish-city` / `publish-course`** (PEM; else `--key-file`, default `.keys/signing-private.pem`). The API never needs it. |

## Publishing a city

```bash
npm run publish-city -- --city krakow --pack ../data/city/krakow --data <DATA_DIR> [--seed ./seed] [--key-file ...]
```

The city pack (`data/city/<cityId>/`, built by `node scripts/pack/split-city.mjs`) holds the city's places: all POIs,
their narrations, sources and the map. publish-city copies every file to `blobs/<sha256>` (checked against the city
pack's own `manifest.json`, re-read and re-hashed), writes the signed `cities/<cityId>/manifest.json` (paths relative
to the city root: `city.json`, `pois.json`, `narrations/en.json`, ...) and re-signs `catalog.json` with the city in
`cities` (`{id, version, names, places, bytes}`), keeping `courses`. Re-publishing an unchanged city changes
nothing. **Publish a city before its courses.**

## Publishing a course

```bash
npm run publish-course -- --course krakow --pack ../data/course/krakow/tour --audio ../data/course/krakow/audio \
  --city-id krakow --data <DATA_DIR> [--seed ./seed] [--root <course root>] [--city <name>]
```

`--pack` is the course overlay `data/course/<id>/tour/` (its tour, stops, legs, demo walk, cover); the older
self-contained full pack `data/course/<id>/packs/<id>/` still works without `--city-id`. Manifest paths are the pack
folder's path relative to the course root (`--root`, default the parent of `--audio`): `tour/...` or
`packs/<id>/...`. With `--city-id` the city must already be published in `DATA_DIR` (its manifest must verify with
the same key), else publish-course fails with "publish the city first"; the course manifest and catalog entry get
`cityId`, the catalog `city` is the city's English name unless `--city` is given, and the allowed set also holds
every narration sentence of the city pack.

1. Copies every pack file and every clip (+ `audio/manifest.json`) to `blobs/<sha256>`; pack files are checked
   against the pack's own manifest and every blob is re-read and re-hashed after writing.
2. Builds `courses/<id>/allowed.json`: the sorted sha256 of every narration sentence, every system/arrival/nav
   line and every numeric line (stop x direction x distance bucket, en/pl/zh), from
   `scripts/voice/system-lines.mjs` (golden-tested against the app's `Phrases.ets`). Kraków: 60 298 lines.
3. Writes the signed `courses/<id>/manifest.json` and re-signs `catalog.json`.
4. Pre-seeds `tts-index.json` with every shipped clip, so a request for a line that has a clip is a cache hit and
   never costs credits.
5. With `--seed`, writes the same signed metadata to `server/seed/` (commit it; it is public and signed).

Re-run it (and commit `server/seed/`) whenever the pack or the clips change. The server refuses to boot from a
seed whose files no longer match (and a vitest case checks the committed seed against the repo files).

## How the course data reaches the disk

Signing happens only on the maintainer's machine; the private key never leaves `server/.keys/` (or your password
manager). The **image** carries the result:

- `server/seed/` (committed): `catalog.json`, `cities/<id>/manifest.json` per city, `courses/<id>/{manifest,allowed}.json`
  per course, `tts-index.json`;
- the course files in `data/course/<id>/` (`tour/...` or the older `packs/<id>/...`, `audio/...`, exactly the
  manifest's paths; the app bundles none of them and downloads them from here). The image copies the whole
  `data/course/` to `SEED_FILES_DIR`, one folder per course id (a `SEED_FILES_DIR` without a `<id>/` folder is read as
  that one course's root, as older images did);
- the city packs in `data/city/<cityId>/`, copied to `SEED_CITY_FILES_DIR` (one folder per city id, same fallback).
  The Docker build context is the repo root for this reason.

Publishing a second course (for example `krakow-scholars`, built with `scripts/pack/build-pack.sh --course
krakow-scholars` and rendered with `render-elevenlabs.mjs --course krakow-scholars`) adds its entry to the same
signed `catalog.json` and keeps the others; `test/multi-course.test.ts` checks two courses end to end.

On every boot (`SEED_DIR` set) the server copies changed metadata (catalog, city and course manifests) to `DATA_DIR`, copies every manifest file that is
missing from `blobs/` (verifying its sha256), and merges the shipped clips into `tts-index.json` while keeping lines
rendered at runtime. So a new deploy = the latest publish, and runtime TTS renders survive on the disk.

## Docker

```bash
docker build -f server/Dockerfile -t citytour-server .      # from the repo root
docker run --rm -p 8080:8080 -v citytour-data:/var/data \
  -e TOKEN_SECRET="$(openssl rand -base64 48)" -e ELEVENLABS_API_KEY=dummy -e TRUST_PROXY=false citytour-server
```

Multi-stage `node:22-alpine`; the server runs as the unprivileged `node` user (the entrypoint only `chown`s a
freshly mounted `/var/data`, then drops privileges with `su-exec`); `HEALTHCHECK` hits `/healthz`.

## Deploy on Render (chosen host)

`render.yaml` at the repo root is a Blueprint: Docker web service from `server/Dockerfile` (context = repo root),
1 GB persistent disk at `/var/data`, health check `/healthz`, `TRUST_PROXY=1`, Frankfurt.

1. Render dashboard -> **New -> Blueprint** -> pick this repository and branch. A persistent disk needs a paid
   instance type (`starter`).
2. Set the two secrets it asks for (`sync: false`): `ELEVENLABS_API_KEY` (an exhausted key is fine for now) and
   `TOKEN_SECRET` (`openssl rand -base64 48`). Defaults: `ELEVENLABS_VOICE_ID`, `TTS_DAILY_CHAR_BUDGET=20000`,
   `DATA_DIR=/var/data`.
3. Keys: run `npm run keygen` once on your machine, keep `server/.keys/signing-private.pem` safe (password manager),
   put the **public** key in the app's `RemoteConfig.ets` together with the Render URL.
4. Publish: `npm run publish-city -- ... --seed ./seed`, then `npm run publish-course -- ... --city-id <city> --seed ./seed`
   for each course, commit `server/seed/`, push. Deploy (auto-deploy is
   off: use **Manual Deploy** or turn it on).
5. Smoke test: `node server/scripts/smoke.mjs https://<service>.onrender.com server/.keys/signing-public.pem`.
6. Check the logs for `evt:"SEED"` (first boot copies ~1167 blobs) and `evt:"LISTEN"`.

**Verify the proxy hop count once deployed:** with `TRUST_PROXY=1`, `req.ip` is the address Render's proxy saw.
If every phone shares one rate-limit bucket (installs 429 quickly), the chain has more hops; raise `TRUST_PROXY`.

Fly.io works the same way: `fly launch --dockerfile server/Dockerfile` from the repo root, `fly volumes create
citytour_data --size 1`, mount it at `/var/data`, `fly secrets set ELEVENLABS_API_KEY=... TOKEN_SECRET=...`,
`TRUST_PROXY=1`, and the same smoke test.

## Security notes

- No free-text TTS: `sha256(text)` must be in the course's allowed set (403 otherwise).
- Spend caps: daily character budget (429), per token+IP rate limit, circuit breaker (401/402/quota: 15 min;
  3 consecutive 429/5xx/timeouts: 60 s), concurrent identical requests share one upstream call.
- `helmet`, no CORS, JSON body limit 2 KB, zod on every input, central error handler (`{error:code}` only, no
  stacks), pino logs with `authorization`, keys, tokens and texts redacted (only the text's sha256 is logged),
  no client IPs in logs.
- Blobs are served only for `^[a-f0-9]{64}$` from `DATA_DIR/blobs`; course ids match `^[a-z0-9][a-z0-9-]{0,63}$`.
- No admin endpoints. Dependencies are pinned (`npm audit`: 0 vulnerabilities at the time of writing).
