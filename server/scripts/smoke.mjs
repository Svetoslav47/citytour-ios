// Smoke test of a running course server (local or deployed). Node 22+, stdlib only. Never calls ElevenLabs
// itself; the TTS line it asks for is a shipped clip (cache hit, no credits), plus one disallowed line (403).
// Usage: node scripts/smoke.mjs <baseUrl> [publicKey: raw base64 | SPKI DER base64 | path to a PEM file]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const keyArg = process.argv[3] || (existsSync('.keys/signing-public.pem') ? '.keys/signing-public.pem' : '');
const SHIPPED = 'That\'s the end of our walk.';   // has a clip in data/course/krakow/audio/manifest.json

function publicKey(s) {
  if (existsSync(s)) {
    return createPublicKey(readFileSync(s, 'utf8'));
  }
  const der = Buffer.from(s, 'base64');
  return der.length === 32 ?
    createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: der.toString('base64url') }, format: 'jwk' }) :
    createPublicKey({ key: der, format: 'der', type: 'spki' });
}

// Same canonicalisation as server/src/canonical.ts (docs/SERVER.md §3).
function canonical(v) {
  if (v === null || typeof v !== 'object') {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(canonical).join(',')}]`;
  }
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failed++;
  }
}

async function get(path, init) {
  const r = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
  return { r, buf: Buffer.from(await r.arrayBuffer()) };
}

const key = keyArg ? publicKey(keyArg) : null;
const verifyEnv = (env) => key !== null && verify(null, Buffer.from(canonical(env.payload), 'utf8'), key,
  Buffer.from(env.sig, 'base64'));

const h = await get('/healthz');
check('GET /healthz', h.r.status === 200 && JSON.parse(h.buf.toString()).ok === true, h.buf.toString());

const c = await get('/v1/catalog');
const cat = JSON.parse(c.buf.toString());
check('GET /v1/catalog signature', c.r.status === 200 && verifyEnv(cat), key ? '' : 'no public key given');
const course = cat.payload?.courses?.[0];
check('catalog lists a course', !!course, course ? `${course.id} ${course.version} ${course.bytes} bytes` : '');

const m = await get(`/v1/courses/${course.id}/manifest`);
const man = JSON.parse(m.buf.toString());
check('GET manifest signature', m.r.status === 200 && verifyEnv(man), `${man.payload?.files?.length} files`);
const f = man.payload.files.find((x) => x.path.endsWith('tours.json')) || man.payload.files[0];
const b = await get(`/v1/blobs/${f.sha256}`);
check(`GET blob ${f.path}`, b.r.status === 200 && sha(b.buf) === f.sha256 &&
  /immutable/.test(b.r.headers.get('cache-control') || ''), `${b.buf.length} bytes`);
for (const city of cat.payload?.cities ?? []) {
  const cm = await get(`/v1/cities/${city.id}/manifest`);
  const cman = JSON.parse(cm.buf.toString());
  check(`GET city ${city.id} manifest signature`, cm.r.status === 200 && verifyEnv(cman) && cman.payload.version === city.version,
    `${cman.payload?.files?.length} files, ${city.places} places`);
}
if (course.cityId) {
  check(`course ${course.id} city ${course.cityId} is in the catalog`, (cat.payload.cities ?? []).some((x) => x.id === course.cityId));
}
const bad = await get('/v1/blobs/..%2F..%2Fcatalog.json');
check('blob path traversal rejected', bad.r.status === 404);

const i = await get('/v1/installs', { method: 'POST' });
const token = JSON.parse(i.buf.toString()).token;
check('POST /v1/installs', i.r.status === 201 && typeof token === 'string');

const tts = (text) => get('/v1/tts', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ courseId: course.id, lang: 'en', text })
});
const t1 = await tts(SHIPPED);
check('POST /v1/tts shipped line = cache hit', t1.r.status === 200 && t1.r.headers.get('x-cache') === 'hit' &&
  t1.r.headers.get('x-text-sha256') === sha(Buffer.from(SHIPPED, 'utf8')) &&
  t1.r.headers.get('content-type') === 'audio/mpeg', `${t1.r.status} ${t1.r.headers.get('x-cache')} ${t1.buf.length} bytes`);
const t2 = await tts('Tell me a joke about Kraków.');
check('POST /v1/tts disallowed text = 403', t2.r.status === 403, t2.buf.toString());
const t3 = await get('/v1/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('POST /v1/tts without token = 401', t3.r.status === 401);

console.log(failed === 0 ? 'SMOKE: PASS' : `SMOKE: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
