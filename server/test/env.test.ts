import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const base = { DATA_DIR: '/tmp/x', TOKEN_SECRET: 's'.repeat(32), ELEVENLABS_API_KEY: 'dummy' };

describe('env', () => {
  it('fails fast listing the missing secrets, without echoing values', () => {
    expect(() => loadEnv({})).toThrow(/DATA_DIR[\s\S]*TOKEN_SECRET[\s\S]*ELEVENLABS_API_KEY/);
    try {
      loadEnv({ ...base, TOKEN_SECRET: 'short-secret-value' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain('TOKEN_SECRET');
      expect(String(e)).not.toContain('short-secret-value');
    }
  });

  it('applies defaults and parses TRUST_PROXY', () => {
    const e = loadEnv(base);
    expect(e.ELEVENLABS_VOICE_ID).toBe('JBFqnCBsd6RMkjVDRZzb');
    expect(e.TTS_DAILY_CHAR_BUDGET).toBe(20000);
    expect(e.TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadEnv({ ...base, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).TRUST_PROXY).toBe('loopback, 10.0.0.0/8');
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'x;rm' })).toThrow();
    expect(() => loadEnv({ ...base, TTS_DAILY_CHAR_BUDGET: '-1' })).toThrow();
  });
});
