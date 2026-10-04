// npm run keygen [-- --out .keys] [--force]
// Writes an Ed25519 keypair to server/.keys/ (gitignored, private key mode 0600) and prints the PUBLIC key only:
// raw 32 bytes in base64, SPKI DER in base64, and PEM. The app ships the public key (RemoteConfig.ets).
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPrivateKey, publicKeyForms } from '../canonical.js';
import { createPublicKey } from 'node:crypto';

export const PRIVATE_FILE = 'signing-private.pem';
export const PUBLIC_FILE = 'signing-public.pem';

function main(argv: string[]): number {
  let out = resolve('.keys');
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') {
      out = resolve(String(argv[++i]));
    } else if (a === '--force') {
      force = true;
    } else {
      console.error(`keygen: unknown option ${a}`);
      return 2;
    }
  }
  const privPath = join(out, PRIVATE_FILE);
  const pubPath = join(out, PUBLIC_FILE);
  let pubPem: string;
  if (existsSync(privPath) && !force) {
    console.log(`keygen: ${privPath} already exists, keeping it (use --force to replace; the app would need the new public key)`);
    pubPem = String(createPublicKey(loadPrivateKey(readFileSync(privPath, 'utf8'))).export({ format: 'pem', type: 'spki' }));
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(privPath, String(privateKey.export({ format: 'pem', type: 'pkcs8' })), { mode: 0o600 });
    chmodSync(privPath, 0o600);
    pubPem = String(publicKey.export({ format: 'pem', type: 'spki' }));
    writeFileSync(pubPath, pubPem);
    console.log(`keygen: wrote ${privPath} (private, never commit) and ${pubPath}`);
  }
  const f = publicKeyForms(createPublicKey(pubPem));
  console.log('');
  console.log('PUBLIC key (safe to ship in the app):');
  console.log(`  raw32 base64 : ${f.raw}`);
  console.log(`  SPKI DER b64 : ${f.spkiDer}`);
  console.log(f.pem.trim());
  return 0;
}

process.exit(main(process.argv.slice(2)));
