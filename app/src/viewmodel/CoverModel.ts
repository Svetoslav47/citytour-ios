/*
 * The cover photo of one course for a screen (Home tour card, Tour detail hero, a Courses row): looked up through
 * CourseRepository.coverFor (installed pack > cached/fetched catalog cover > none, core/remote/CoverRules.ets), with
 * a timeout, off the UI thread. `loading` keeps a placeholder in the slot until the answer is known, so Home and
 * Tour detail never flash the map before the photo; `path` '' after loading = show the fallback (the map preview).
 */
import { Lang } from '@citytour/core';
import { AppContainer } from '../app/AppContainer';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';
import { CoverChoice, CoverView, coverView } from '@citytour/core';
import { withTimeout } from './Async';

/** Lookup budget: the cached/installed answer is instant; a catalog fetch may take this long before we give up. */
const COVER_TIMEOUT_MS: number = 20000;

export class CoverModel {
  courseId: string = '';
  path: string = '';
  loading: boolean = false;
  private seq: number = 0;

  view(): CoverView {
    return coverView(this.loading, this.path);
  }

  /** Looks up the cover of `courseId`; `fetch` = may download the catalog cover now. Never rejects. */
  async load(courseId: string, fetch: boolean): Promise<void> {
    const my = ++this.seq;
    if (courseId === '') {
      this.courseId = '';
      this.path = '';
      this.loading = false;
      return;
    }
    if (courseId !== this.courseId) {
      this.courseId = courseId;
      this.path = '';
    }
    this.loading = this.path === '';
    let c = new CoverChoice();
    try {
      c = await withTimeout(AppContainer.courses().coverFor(courseId, fetch), COVER_TIMEOUT_MS, new CoverChoice(),
        'cover.lookup');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=CoverModel.load ${Log.errKv(e as Object)}`);
    }
    if (my !== this.seq) {
      return;   // a newer lookup (other course or language) won
    }
    this.path = c.path;
    this.loading = false;
    Log.i(LogEvents.COURSE, `event=cover id=${courseId} source=${c.source}${c.path === '' ? ' fallback=map' : ''}`);
  }
}

/** UI language code of the cover alt text. */
export function coverLang(lang: Lang): string {
  return lang === Lang.PL ? 'pl' : lang === Lang.ZH ? 'zh' : 'en';
}
