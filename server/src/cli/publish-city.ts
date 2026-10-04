// npm run publish-city -- --city krakow --pack ../data/city/krakow --data <DATA_DIR> [--seed seed]
//                         [--key-file .keys/signing-private.pem]
// Publishes a city pack (built by node scripts/pack/split-city.mjs): verified blobs, the signed
// cities/<cityId>/manifest.json and the city's entry in the signed catalog. Publish a city BEFORE its courses
// (publish-course --city-id reads it). Signing key: SIGNING_PRIVATE_KEY (PEM, env) if set, else --key-file
// (default .keys/signing-private.pem from `npm run keygen`). Never prints the key.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicKey } from 'node:crypto';
import { loadPrivateKey, publicKeyForms } from '../canonical.js';
import { publishCity } from '../publish.js';

async function main(argv: string[]): Promise<number> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith('--') || i + 1 >= argv.length) {
      console.error(`publish-city: bad argument ${a}`);
      return 2;
    }
    o[a.slice(2)] = String(argv[++i]);
  }
  for (const req of ['city', 'pack', 'data']) {
    if (!o[req]) {
      console.error(`publish-city: --${req} is required`);
      return 2;
    }
  }
  const pem = process.env.SIGNING_PRIVATE_KEY && process.env.SIGNING_PRIVATE_KEY.trim().length > 0 ?
    process.env.SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n') :
    readFileSync(resolve(o['key-file'] ?? '.keys/signing-private.pem'), 'utf8');
  const privateKey = loadPrivateKey(pem);
  const r = await publishCity({
    cityId: String(o.city),
    packDir: resolve(String(o.pack)),
    dataDir: resolve(String(o.data)),
    seedDir: o.seed ? resolve(o.seed) : undefined,
    privateKey,
    log: (s) => console.log(`publish-city: ${s}`)
  });
  console.log(`publish-city: blobs written ${r.blobsWritten}`);
  console.log(`publish-city: catalog entry ${JSON.stringify(r.summary)}`);
  console.log(`publish-city: signed with public key ${publicKeyForms(createPublicKey(privateKey)).raw}`);
  return 0;
}

main(process.argv.slice(2)).then((c) => process.exit(c), (e: unknown) => {
  console.error(`publish-city: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
