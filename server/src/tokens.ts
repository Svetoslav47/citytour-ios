// Install tokens (docs/SERVER.md §3 POST /v1/installs): an HMAC-SHA256 signed {iid, iat, exp}. Not identity, only a
// throttle key for /v1/tts. Format: base64url(json) "." base64url(hmac(TOKEN_SECRET, base64url(json))).
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const TOKEN_TTL_S = 30 * 24 * 3600;

export interface TokenClaims {
  iid: string;
  iat: number;
  exp: number;
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body, 'utf8').digest();
}

export function issueToken(secret: string, nowS: number = Math.floor(Date.now() / 1000)): {
  token: string; claims: TokenClaims;
} {
  const claims: TokenClaims = { iid: randomUUID(), iat: nowS, exp: nowS + TOKEN_TTL_S };
  const body = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return { token: `${body}.${mac(secret, body).toString('base64url')}`, claims };
}

/** The claims of a valid, unexpired token, else null. Constant-time MAC comparison. */
export function verifyToken(secret: string, token: string, nowS: number = Math.floor(Date.now() / 1000)):
  TokenClaims | null {
  if (token.length > 512) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  const [body, sig] = parts as [string, string];
  const want = mac(secret, body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return null;
  }
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TokenClaims>;
    if (typeof c.iid !== 'string' || typeof c.iat !== 'number' || typeof c.exp !== 'number') {
      return null;
    }
    if (c.exp <= nowS) {
      return null;
    }
    return { iid: c.iid, iat: c.iat, exp: c.exp };
  } catch {
    return null;
  }
}
