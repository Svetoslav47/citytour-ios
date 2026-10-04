// ElevenLabs text-to-speech, the same request as scripts/voice/render-elevenlabs.mjs (model, output format and
// voice_settings), so runtime lines sound like the shipped clips. The key is sent only in the xi-api-key header
// and never appears in errors or logs. One attempt, AbortController timeout; retries are the app's fallback.

export interface SynthRequest {
  text: string;
  lang: string;
}

/** Upstream failure with only the status (no body, no key). */
export class UpstreamError extends Error {
  constructor(readonly status: number, readonly kind: 'auth' | 'quota' | 'rate' | 'server' | 'timeout' | 'network' |
    'bad_request' | 'bad_audio') {
    super(`elevenlabs ${kind}${status ? ` ${status}` : ''}`);
  }
}

export interface Synthesizer {
  synthesize(req: SynthRequest): Promise<Buffer>;
}

export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  outputFormat?: string;
  fetchImpl?: typeof fetch;
}

export const OUTPUT_FORMAT = 'mp3_22050_32';
export const VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };

export class ElevenLabs implements Synthesizer {
  constructor(private readonly cfg: ElevenLabsConfig) {}

  async synthesize(req: SynthRequest): Promise<Buffer> {
    const f = this.cfg.fetchImpl ?? fetch;
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/v1/text-to-speech/${encodeURIComponent(this.cfg.voiceId)}` +
      `?output_format=${this.cfg.outputFormat ?? OUTPUT_FORMAT}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.cfg.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text: req.text, model_id: this.cfg.model, voice_settings: VOICE_SETTINGS }),
        signal: ac.signal
      });
    } catch (e) {
      throw new UpstreamError(0, ac.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new UpstreamError(res.status, /quota|credits/i.test(body) ? 'quota' : 'auth');
      }
      if (res.status === 402) {
        throw new UpstreamError(res.status, 'quota');
      }
      if (res.status === 429) {
        throw new UpstreamError(res.status, 'rate');
      }
      if (res.status >= 500) {
        throw new UpstreamError(res.status, 'server');
      }
      throw new UpstreamError(res.status, /quota|credits/i.test(body) ? 'quota' : 'bad_request');
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 256) {
      throw new UpstreamError(res.status, 'bad_audio');
    }
    return buf;
  }
}
