// Entry point: validate env (fail fast), seed DATA_DIR, listen.
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { loadEnv } from './env.js';
import { createLogger } from './log.js';
import { seedDataDir } from './seed.js';
import { DataStore } from './store.js';
import { CircuitBreaker } from './tts/breaker.js';
import { ElevenLabs } from './tts/elevenlabs.js';
import { TtsService } from './tts/service.js';

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (e) {
    // Only the variable names and rules are printed, never values.
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const log = createLogger(env.LOG_LEVEL);
  const store = new DataStore(env.DATA_DIR);
  await store.init();
  if (env.SEED_DIR) {
    await seedDataDir(store, env.SEED_DIR, env.SEED_FILES_DIR, log, env.SEED_CITY_FILES_DIR);
  }
  const synth = new ElevenLabs({
    apiKey: env.ELEVENLABS_API_KEY, voiceId: env.ELEVENLABS_VOICE_ID, model: env.ELEVENLABS_MODEL,
    baseUrl: env.ELEVENLABS_BASE_URL, timeoutMs: env.TTS_TIMEOUT_MS
  });
  const tts = new TtsService(store, synth, new CircuitBreaker(), env.TTS_DAILY_CHAR_BUDGET, log);
  const app = createApp({
    store, tts, log, tokenSecret: env.TOKEN_SECRET, version: version(), trustProxy: env.TRUST_PROXY,
    rateInstallsPerHour: env.RATE_INSTALLS_PER_HOUR, rateTtsPer10Min: env.RATE_TTS_PER_10MIN
  });
  const server = app.listen(env.PORT, env.HOST, () => {
    log.info({ evt: 'LISTEN', host: env.HOST, port: env.PORT, dataDir: env.DATA_DIR, trustProxy: env.TRUST_PROXY,
      budget: env.TTS_DAILY_CHAR_BUDGET, voiceId: env.ELEVENLABS_VOICE_ID }, 'citytour server up');
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;
  const stop = (sig: string): void => {
    log.info({ evt: 'STOP', sig }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e: unknown) => {
  console.error('fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
