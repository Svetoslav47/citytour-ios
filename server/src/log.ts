// Structured logs (pino). Redacted: the Authorization header, any API key, install tokens and the TTS text
// (only its sha256 is logged). Client IPs and ports are not logged (no personal data, docs/SERVER.md §1).
import pino, { Logger } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["xi-api-key"]',
  'req.headers.cookie',
  'req.body',
  'body.text',
  'text',
  'token',
  'apiKey',
  '*.apiKey',
  '*.token',
  '*.text',
  'ELEVENLABS_API_KEY',
  'TOKEN_SECRET',
  'SIGNING_PRIVATE_KEY'
];

export function createLogger(level: string, destination?: pino.DestinationStream): Logger {
  return pino(
    {
      level,
      base: { svc: 'citytour-server' },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime
    },
    destination
  );
}
