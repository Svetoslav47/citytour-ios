// Suite: StreamRules.test - module under test: core/remote/StreamRules (SERVER.md §6 "Streaming a course").
// Cases: which course/city files a stream fetches up front (no clips, no city places/stories); downloaded wins over
// streamed; streamed courses can be active after the downloaded ones; when Play now must (re)prepare; "All places"
// only with the city downloaded; Download reuses the stream's files; the row's Play now / Download buttons; the clip
// chain (on device -> play, unknown or offline back-off -> fallback, else fetch); prefetch of the next sentences.
import { describe, it, expect } from 'vitest';
import {
  activeCandidates, allPlacesAvailable, clipStep, ClipStep, StreamCourseSource as CourseSource, courseSource, isClipFile, prefetchAfter,
  reusableForDownload, StreamClip, streamCityFiles, streamClipFiles, streamCourseFiles, streamNeedsPrepare,
  streamRowActions
} from '../src';
import { InstalledCourse } from '../src';
import { CourseFile } from '../src';
import { ClipEntry, ClipIndex, ClipReason } from '../src';

function file(path: string): CourseFile {
  const f = new CourseFile();
  f.path = path;
  f.sha256 = 'a'.repeat(64);
  f.bytes = 10;
  return f;
}

function paths(fs: CourseFile[]): string {
  return fs.map((f: CourseFile) => f.path).join(',');
}

function inst(id: string): InstalledCourse {
  const i = new InstalledCourse();
  i.id = id;
  i.version = 'v1';
  return i;
}

function clip(poiId: string, n: number, lang: string = 'en', length: string = 'full'): StreamClip {
  const c = new StreamClip();
  c.lang = lang;
  c.poiId = poiId;
  c.personaId = 'guide';
  c.length = length;
  c.n = n;
  c.file = `/s/audio/${lang}/${poiId}/${length}_${n}.mp3`;
  return c;
}

function streamRulesTest() {
  describe('StreamRules', () => {
    it('courseFilesWithoutClips', () => {
      const fs = [file('tour/manifest.json'), file('tour/pois.json'), file('tour/narrations/en.json'),
        file('audio/manifest.json'), file('audio/en/poi_a/full_0.mp3'), file('audio/pl/sys/x.mp3')];
      expect(paths(streamCourseFiles(fs, 'audio/manifest.json')))
        .toBe('tour/manifest.json,tour/pois.json,tour/narrations/en.json,audio/manifest.json');
      expect(paths(streamClipFiles(fs, 'audio/manifest.json'))).toBe('audio/en/poi_a/full_0.mp3,audio/pl/sys/x.mp3');
      expect(isClipFile('audio/manifest.json', 'audio/manifest.json')).toBe(false);
      expect(isClipFile('tour/audio.json', 'audio/manifest.json')).toBe(false);
    });

    it('cityFilesOnlyManifestCityJsonMap', () => {
      const fs = [file('city.json'), file('manifest.json'), file('map-detail.json'), file('pois.json'),
        file('narrations/en.json'), file('sources.json')];
      expect(paths(streamCityFiles(fs))).toBe('city.json,manifest.json,map-detail.json');
    });

    it('downloadedWinsOverStreamed', () => {
      expect(courseSource('a', ['a'], ['a'])).toBe(CourseSource.DOWNLOADED);
      expect(courseSource('b', ['a'], ['b'])).toBe(CourseSource.STREAMED);
      expect(courseSource('c', ['a'], ['b'])).toBe(CourseSource.NONE);
      expect(courseSource('', ['a'], [''])).toBe(CourseSource.NONE);
    });

    it('activeCandidatesDownloadedFirst', () => {
      const c = activeCandidates([inst('a')], [inst('a'), inst('b')]);
      expect(c.map((i: InstalledCourse) => i.id).join(',')).toBe('a,b');
      expect(activeCandidates([], [inst('s')]).length).toBe(1);
    });

    it('prepareWhenMissingOrNewer', () => {
      expect(streamNeedsPrepare('', 'v1')).toBe(true);
      expect(streamNeedsPrepare('v1', 'v1')).toBe(false);
      expect(streamNeedsPrepare('v1', 'v2')).toBe(true);
      expect(streamNeedsPrepare('v1', '')).toBe(false);   // offline: keep the streamed copy
    });

    it('allPlacesNeedsTheCity', () => {
      expect(allPlacesAvailable('krakow', false)).toBe(false);
      expect(allPlacesAvailable('krakow', true)).toBe(true);
      expect(allPlacesAvailable('', false)).toBe(true);
    });

    it('downloadReusesStreamedFiles', () => {
      const fs = [file('tour/pois.json'), file('audio/manifest.json'), file('audio/en/p/full_0.mp3'),
        file('audio/en/p/full_1.mp3')];
      expect(paths(reusableForDownload(fs, ['tour/pois.json', 'audio/en/p/full_1.mp3', 'other.json'])))
        .toBe('tour/pois.json,audio/en/p/full_1.mp3');
      expect(reusableForDownload(fs, []).length).toBe(0);
    });

    it('rowActions', () => {
      const avail = streamRowActions(CourseSource.NONE, false, true);
      expect(avail.playNow).toBe(true);
      expect(avail.download).toBe(true);
      expect(avail.streaming).toBe(false);
      const playing = streamRowActions(CourseSource.STREAMED, true, true);
      expect(playing.playNow).toBe(false);   // already the active walk
      expect(playing.download).toBe(true);   // upgrade to offline
      expect(playing.streaming).toBe(true);
      const other = streamRowActions(CourseSource.STREAMED, false, true);
      expect(other.playNow).toBe(true);
      const offline = streamRowActions(CourseSource.STREAMED, false, false);
      expect(offline.playNow).toBe(true);    // a streamed copy can be used without the server
      expect(offline.download).toBe(false);
      expect(streamRowActions(CourseSource.NONE, false, false).playNow).toBe(false);
      const dl = streamRowActions(CourseSource.DOWNLOADED, false, true);
      expect(dl.playNow || dl.download || dl.streaming).toBe(false);
    });

    it('clipChain', () => {
      expect(clipStep(true, true, 1000, 5000)).toBe(ClipStep.PLAY);     // cached plays even offline
      expect(clipStep(false, true, 1000, 0)).toBe(ClipStep.FETCH);
      expect(clipStep(false, true, 1000, 5000)).toBe(ClipStep.FALLBACK); // offline back-off: no 3 s wait
      expect(clipStep(false, false, 1000, 0)).toBe(ClipStep.FALLBACK);   // not in the signed manifest
    });

    it('prefetchNextSentencesOfTheStory', () => {
      const all = [clip('a', 0), clip('a', 3), clip('a', 1), clip('a', 2), clip('a', 4), clip('b', 1),
        clip('a', 1, 'pl'), clip('a', 1, 'en', 'short')];
      const got = prefetchAfter(all, clip('a', 0), 3);
      expect(got.join(',')).toBe('/s/audio/en/a/full_1.mp3,/s/audio/en/a/full_2.mp3,/s/audio/en/a/full_3.mp3');
      expect(prefetchAfter(all, clip('a', 4)).length).toBe(0);
      expect(prefetchAfter(all, clip('', 0)).length).toBe(0);   // system lines: on demand only
    });

    it('lateClipPlaysAgain', () => {
      // A streamed clip that missed its 3 s budget is marked unavailable (the sentence falls back), then plays again
      // once it arrives.
      const e: ClipEntry = {
        lang: 'en', poiId: 'a', personaId: 'guide', length: 'full', n: 0, file: '/s/a.mp3', textSha256: 'f'.repeat(64),
        durationMs: 0
      };
      const idx = new ClipIndex([e]);
      idx.markFailed('/s/a.mp3');
      expect(idx.find('f'.repeat(64), 'en', 'guide').reason).toBe(ClipReason.CLIP_FAILED);
      idx.clearFailed('/s/a.mp3');
      expect(idx.find('f'.repeat(64), 'en', 'guide').reason).toBe(ClipReason.HASH_MATCH);
    });
  });
}

streamRulesTest();
