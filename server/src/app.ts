// HTTP API v1 (docs/SERVER.md §3) with the hardening of §4.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { z } from 'zod';
import { COURSE_ID_RE, DataStore, SHA256_RE } from './store.js';
import { issueToken, verifyToken } from './tokens.js';
import { TtsService } from './tts/service.js';

export interface AppOptions {
  store: DataStore;
  tts: TtsService;
  log: Logger;
  tokenSecret: string;
  version: string;
  trustProxy: boolean | number | string;
  rateInstallsPerHour: number;
  rateTtsPer10Min: number;
}

export const TTS_MAX_CHARS = 400;

export const TtsBody = z.strictObject({
  courseId: z.string().regex(COURSE_ID_RE),
  lang: z.enum(['en', 'pl', 'zh']),
  text: z.string().min(1).max(TTS_MAX_CHARS)
});

/** An error with a public status and code; anything else becomes a 500 with no detail. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function sendJsonFile(res: Response, buf: Buffer): void {
  res.status(200).type('application/json').set('Cache-Control', 'public, max-age=60, must-revalidate').send(buf);
}

export function createApp(o: AppOptions): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', o.trustProxy);
  app.set('etag', false);
  app.set('json escape', true);

  app.use(pinoHttp({
    logger: o.log,
    // Only method, path and status: no headers (tokens), no body (text), no client IP.
    serializers: {
      req: (req: { method?: string; url?: string; id?: unknown }) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode })
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info')
  }));
  app.use(helmet());
  // No CORS: the only client is the native app, so no Access-Control-* header is ever sent.

  const installLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: o.rateInstallsPerHour,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited' }
  });
  const ttsLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: o.rateTtsPer10Min,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'rate_limited' },
    keyGenerator: (req: Request) => `${String(res_iid(req))}|${ipKeyGenerator(req.ip ?? '0.0.0.0')}`
  });

  const json = express.json({ limit: '2kb', strict: true, type: 'application/json' });

  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, version: o.version });
  });

  app.post('/v1/installs', installLimiter, (_req, res) => {
    const { token, claims } = issueToken(o.tokenSecret);
    res.set('Cache-Control', 'no-store').status(201)
      .json({ token, expiresAt: new Date(claims.exp * 1000).toISOString() });
  });

  app.get('/v1/catalog', async (_req, res) => {
    const buf = await o.store.catalog();
    if (!buf) {
      throw new HttpError(404, 'no_catalog');
    }
    sendJsonFile(res, buf);
  });

  app.get('/v1/courses/:courseId/manifest', async (req, res) => {
    const id = String(req.params.courseId);
    if (!COURSE_ID_RE.test(id)) {
      throw new HttpError(404, 'not_found');
    }
    const buf = await o.store.manifest(id);
    if (!buf) {
      throw new HttpError(404, 'not_found');
    }
    sendJsonFile(res, buf);
  });

  app.get('/v1/cities/:cityId/manifest', async (req, res) => {
    const id = String(req.params.cityId);
    if (!COURSE_ID_RE.test(id)) {
      throw new HttpError(404, 'not_found');
    }
    const buf = await o.store.cityManifest(id);
    if (!buf) {
      throw new HttpError(404, 'not_found');
    }
    sendJsonFile(res, buf);
  });

  app.get('/v1/blobs/:sha256', async (req, res) => {
    const sha = String(req.params.sha256);
    const path = SHA256_RE.test(sha) ? o.store.blobPath(sha) : null;
    if (path === null) {
      throw new HttpError(404, 'not_found');
    }
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) {
        throw new Error('not a file');
      }
      size = st.size;
    } catch {
      throw new HttpError(404, 'not_found');
    }
    const etag = `"${sha}"`;
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag });
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) });
    await streamFile(path, res);
  });

  app.post('/v1/tts', requireToken(o.tokenSecret), ttsLimiter, json, async (req, res) => {
    const parsed = TtsBody.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request');
    }
    const r = await o.tts.handle(parsed.data);
    res.set('Cache-Control', 'no-store');
    switch (r.kind) {
      case 'unknown_course':
        throw new HttpError(404, 'unknown_course');
      case 'not_allowed':
        res.set('X-Text-Sha256', r.textSha);
        throw new HttpError(403, 'not_allowed');
      case 'budget':
        res.set('Retry-After', String(secondsToUtcMidnight()));
        throw new HttpError(429, 'budget');
      case 'unavailable':
        res.set('Retry-After', String(r.retryAfterS));
        throw new HttpError(503, 'tts_unavailable');
      case 'upstream_error':
        throw new HttpError(502, 'tts_upstream');
      case 'audio': {
        const path = o.store.blobPath(r.blobSha);
        if (path === null) {
          throw new Error('bad blob');
        }
        const st = await stat(path);
        res.status(200).set({
          'Content-Type': 'audio/mpeg', 'Content-Length': String(st.size), 'X-Text-Sha256': r.textSha,
          'X-Cache': r.cache, 'X-Blob-Sha256': r.blobSha
        });
        await streamFile(path, res);
        return;
      }
    }
  });

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found')));

  // Central error handler: a public code only, never a message or stack.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let code = 'internal';
    if (err instanceof HttpError) {
      status = err.status;
      code = err.code;
    } else if (isBodyParserError(err)) {
      status = err.status;
      code = err.type === 'entity.too.large' ? 'payload_too_large' : 'bad_request';
    }
    if (status >= 500) {
      req.log?.error({ err }, 'request failed');
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).set('Cache-Control', 'no-store').json({ error: code });
  });

  return app;
}

function res_iid(req: Request): string {
  return (req as Request & { iid?: string }).iid ?? '-';
}

function requireToken(secret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(h);
    const claims = m && m[1] ? verifyToken(secret, m[1]) : null;
    if (!claims) {
      next(new HttpError(401, 'unauthorized'));
      return;
    }
    (req as Request & { iid?: string }).iid = claims.iid;
    next();
  };
}

function isBodyParserError(e: unknown): e is { status: number; type: string } {
  if (typeof e !== 'object' || e === null) {
    return false;
  }
  const o = e as { status?: unknown; type?: unknown };
  return typeof o.status === 'number' && o.status >= 400 && o.status < 500 && typeof o.type === 'string';
}

function streamFile(path: string, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createReadStream(path);
    s.on('error', (e) => {
      res.destroy();
      reject(e);
    });
    res.on('close', () => {
      s.destroy();
      resolve();
    });
    s.pipe(res);
  });
}

function secondsToUtcMidnight(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
