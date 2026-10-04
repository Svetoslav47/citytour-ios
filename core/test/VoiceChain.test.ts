// Suite: VoiceChain.test - module under test: core/remote/VoiceChain (SERVER.md §2 fallback chain).
// Cases: clip -> cache -> remote -> tts -> text (Polish); the user's text-only / listen choice; server disabled and
// toggle off; offline and budget back-off; and judging a /v1/tts response: ok, timeout, network error, 429, 5xx,
// 4xx, X-Text-Sha256 mismatch or missing, empty body, wrong content type.
import { describe, it, expect } from 'vitest';
import {
  BUDGET_BACKOFF_MS, ChainInput, decideVoice, judgeRemote, OFFLINE_BACKOFF_MS, REMOTE_BUDGET_MS, RemoteResult,
  ServerState, serverStateText, VoiceSrc
} from '../src';

const SHA: string = '6b57aa9020f95bb52345b5d986292da081ea900be66916d2410916c350c39573';

function input(): ChainInput {
  const i = new ChainInput();
  i.serverConfigured = true;
  i.toggleOn = true;
  i.nowMs = 1000000;
  return i;
}

function ok(): RemoteResult {
  const r = new RemoteResult();
  r.status = 200;
  r.headerSha = SHA;
  r.contentType = 'audio/mpeg';
  r.bytes = 12000;
  r.elapsedMs = 800;
  return r;
}

function voiceChainTest() {
  describe('VoiceChain', () => {
    it('clipFirst', () => {
      const i = input();
      i.localClip = true;
      i.cached = true;
      expect(decideVoice(i).src).toBe(VoiceSrc.CLIP);
    });

    it('cacheThenRemote', () => {
      const i = input();
      i.cached = true;
      expect(decideVoice(i).src).toBe(VoiceSrc.REMOTE_CACHE);
      i.cached = false;
      const s = decideVoice(i);
      expect(s.src).toBe(VoiceSrc.REMOTE);
      expect(s.fallback).toBe(VoiceSrc.TTS);
    });

    it('polishFallsBackToText', () => {
      const i = input();
      i.platformText = true;
      expect(decideVoice(i).fallback).toBe(VoiceSrc.TEXT);
      i.serverConfigured = false;
      const s = decideVoice(i);
      expect(s.src).toBe(VoiceSrc.TEXT);
      expect(s.reason).toBe('server_disabled');
    });

    it('userChoiceAndToggle', () => {
      const i = input();
      i.userOptOut = true;
      i.cached = true;
      expect(decideVoice(i).src).toBe(VoiceSrc.TTS);
      expect(decideVoice(i).reason).toBe('user_choice');
      const j = input();
      j.toggleOn = false;
      j.cached = true;
      expect(decideVoice(j).src).toBe(VoiceSrc.TTS);
      expect(decideVoice(j).reason).toBe('toggle_off');
    });

    it('backoffSkipsServer', () => {
      const i = input();
      i.offlineUntilMs = i.nowMs + 1;
      expect(decideVoice(i).reason).toBe('offline');
      i.offlineUntilMs = 0;
      i.budgetUntilMs = i.nowMs + 1;
      expect(decideVoice(i).reason).toBe('budget');
      i.budgetUntilMs = i.nowMs;   // expired
      expect(decideVoice(i).src).toBe(VoiceSrc.REMOTE);
      // a cached line still plays offline
      i.offlineUntilMs = i.nowMs + 1;
      i.cached = true;
      expect(decideVoice(i).src).toBe(VoiceSrc.REMOTE_CACHE);
    });

    it('limitsAndCourse', () => {
      const i = input();
      i.textSendable = false;
      expect(decideVoice(i).reason).toBe('text_limits');
      const j = input();
      j.courseKnown = false;
      expect(decideVoice(j).reason).toBe('no_course');
    });

    it('judgeOk', () => {
      const v = judgeRemote(ok(), SHA);
      expect(v.accept).toBe(true);
      expect(v.server).toBe(ServerState.ONLINE);
      const upper = ok();
      upper.headerSha = SHA.toUpperCase();
      expect(judgeRemote(upper, SHA).accept).toBe(true);
    });

    it('judgeTimeout', () => {
      const r = ok();
      r.timedOut = true;
      expect(judgeRemote(r, SHA).reason).toBe('timeout');
      const late = ok();
      late.elapsedMs = REMOTE_BUDGET_MS + 1;
      expect(judgeRemote(late, SHA).accept).toBe(false);
      expect(judgeRemote(late, SHA).offlineForMs).toBe(0);
    });

    it('judgeOfflineAndBudget', () => {
      const net = new RemoteResult();
      const v = judgeRemote(net, SHA);
      expect(v.reason).toBe('offline');
      expect(v.server).toBe(ServerState.OFFLINE);
      expect(v.offlineForMs).toBe(OFFLINE_BACKOFF_MS);
      const r = ok();
      r.status = 429;
      const b = judgeRemote(r, SHA);
      expect(b.reason).toBe('http_429');
      expect(b.server).toBe(ServerState.BUDGET);
      expect(b.budgetForMs).toBe(BUDGET_BACKOFF_MS);
      r.status = 503;
      expect(judgeRemote(r, SHA).server).toBe(ServerState.OFFLINE);
      r.status = 403;
      expect(judgeRemote(r, SHA).reason).toBe('http_403');
      expect(judgeRemote(r, SHA).server).toBe(ServerState.ONLINE);
      expect(judgeRemote(r, SHA).neverRetry).toBe(true);
      r.status = 502;
      expect(judgeRemote(r, SHA).accept).toBe(false);
      expect(judgeRemote(r, SHA).neverRetry).toBe(false);
      r.status = 401;
      expect(judgeRemote(r, SHA).accept).toBe(false);
    });

    it('judgeMismatch', () => {
      const r = ok();
      r.headerSha = 'b'.repeat(64);
      expect(judgeRemote(r, SHA).reason).toBe('sha_mismatch');
      r.headerSha = '';
      expect(judgeRemote(r, SHA).reason).toBe('sha_missing');
      const e = ok();
      e.bytes = 0;
      expect(judgeRemote(e, SHA).reason).toBe('empty_body');
      const t = ok();
      t.contentType = 'application/json';
      expect(judgeRemote(t, SHA).reason).toBe('content_type');
      expect(judgeRemote(ok(), '').accept).toBe(false);
    });

    it('serverText', () => {
      expect(serverStateText(ServerState.DISABLED)).toBe('server disabled');
      expect(serverStateText(ServerState.BUDGET)).toBe('server budget reached');
    });
  });
}

voiceChainTest();
