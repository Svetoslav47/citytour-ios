// Environment, validated with zod at boot (docs/SERVER.md §4: secrets validated at boot, fail fast).
// Secrets come ONLY from process.env; their values are never logged (see log.ts redaction).
import { z } from 'zod';

const trustProxy = z
  .string()
  .default('false')
  .transform((v, ctx): boolean | number | string => {
    const s = v.trim();
    if (s === 'false' || s === '0' || s === '') {
      return false;
    }
    if (s === 'true') {
      return true;
    }
    if (/^\d+$/.test(s)) {
      return Number(s);           // number of proxy hops in front of the app (Render: 1)
    }
    if (/^[\w.:/,\s-]+$/.test(s)) {
      return s;                   // subnet list / names understood by Express ("loopback, 10.0.0.0/8")
    }
    ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY must be false, true, a hop count or a subnet list' });
    return z.NEVER;
  });

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: intFrom(8080, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATA_DIR: z.string().min(1, 'DATA_DIR is required'),
  // Optional seed baked into the image (signed metadata + the repo's pack/audio files), copied to DATA_DIR on boot.
  SEED_DIR: z.string().optional(),
  SEED_FILES_DIR: z.string().optional(),
  SEED_CITY_FILES_DIR: z.string().optional(),   // the repo's data/city: one folder per city id
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET must be at least 32 characters (32+ random bytes, e.g. base64)'),
  ELEVENLABS_API_KEY: z.string().min(1, 'ELEVENLABS_API_KEY is required (an exhausted key is fine: TTS falls back)'),
  ELEVENLABS_VOICE_ID: z.string().regex(/^[A-Za-z0-9]{8,64}$/).default('JBFqnCBsd6RMkjVDRZzb'),
  ELEVENLABS_MODEL: z.string().regex(/^[a-z0-9_]{1,64}$/).default('eleven_multilingual_v2'),
  ELEVENLABS_BASE_URL: z.url().default('https://api.elevenlabs.io'),
  TTS_DAILY_CHAR_BUDGET: intFrom(20000, 0, 10_000_000),
  TTS_TIMEOUT_MS: intFrom(10000, 500, 60000),
  TRUST_PROXY: trustProxy,
  RATE_INSTALLS_PER_HOUR: intFrom(20, 1, 100000),
  RATE_TTS_PER_10MIN: intFrom(300, 1, 100000)
});

export type Env = z.infer<typeof EnvSchema>;

/** Parses the environment; throws one readable error listing every problem (never echoing the values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`invalid environment:\n${lines.join('\n')}`);
  }
  return r.data;
}
