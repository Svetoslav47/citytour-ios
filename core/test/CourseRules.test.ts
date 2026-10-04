// Suite: CourseRules.test - module under test: core/remote/CourseRules (SERVER.md §6 CourseRepository + Courses screen).
// The app ships NO built-in course. Cases: first run lists only the catalog (nothing installed, no active course);
// catalog-only = Download; installed + same version = Downloaded; another version = Update; installed courses stay
// listed offline; the active id resolves to '' with nothing installed, to the saved one, or to the first installed;
// the first download becomes active, a later one does not; delete (active -> another installed course or none);
// install replaces an older version; Home's mode (loading / empty state / ready / error); the Demo walk for any active
// course whose pack ships a demo track (no course id is special); two courses of one city side by side; the city
// places pack: download when missing/outdated, removal with the last course of the city; titles, sizes and progress.
import { describe, it, expect } from 'vitest';
import {
  activeAfterInstall, afterDelete, afterInstall, cityNeedsDownload, downloadBytes, CourseRow, CourseState, courseTitle,
  demoWalkOffered, orphanCities, HomeMode, homeMode, InstalledCourse, mergeCourses, progressPct, resolveActive, sizeLabel
} from '../src';
import { CourseSummary } from '../src';

function course(id: string, version: string): CourseSummary {
  const c = new CourseSummary();
  c.id = id;
  c.version = version;
  c.title.en = `${id} en`;
  c.title.pl = `${id} pl`;
  return c;
}

function installed(id: string, version: string): InstalledCourse {
  const i = new InstalledCourse();
  i.id = id;
  i.version = version;
  i.summary = course(id, version);
  return i;
}

function ids(rows: CourseRow[]): string {
  return rows.map((r: CourseRow) => `${r.summary.id}:${r.state}`).join(',');
}

function courseRulesTest() {
  describe('CourseRules', () => {
    it('firstRunNoBuiltInCourse', () => {
      // No server reached and nothing installed: no rows at all (the UI shows the offline/empty note).
      expect(mergeCourses([], undefined, '').length).toBe(0);
      const rows = mergeCourses([], [course('krakow', '1')], '');
      expect(ids(rows)).toBe('krakow:available');
      expect(rows[0].active).toBe(false);
      expect(rows[0].canDelete).toBe(false);
      expect(rows[0].canSelect).toBe(false);
      expect(resolveActive('', [])).toBe('');
    });

    it('catalogStates', () => {
      const cat = [course('krakow', '1.0.0'), course('gdansk', '2'), course('warsaw', '1')];
      const rows = mergeCourses([installed('gdansk', '2'), installed('warsaw', '0')], cat, 'gdansk');
      expect(ids(rows)).toBe('krakow:available,gdansk:downloaded,warsaw:update');
      expect(rows[1].active).toBe(true);
      expect(rows[0].active).toBe(false);
      expect(rows[1].canDelete).toBe(true);
      expect(rows[1].canSelect).toBe(true);
      expect(rows[2].installedVersion).toBe('0');
      expect(rows[2].summary.version).toBe('1');   // the row shows the catalog version
    });

    it('offlineKeepsInstalled', () => {
      const rows = mergeCourses([installed('krakow', '2')], undefined, 'krakow');
      expect(ids(rows)).toBe('krakow:downloaded');
      expect(rows[0].active).toBe(true);
      // a course the server no longer lists stays usable
      expect(ids(mergeCourses([installed('gdansk', '2')], [course('warsaw', '1')], '')))
        .toBe('warsaw:available,gdansk:downloaded');
    });

    it('activeResolution', () => {
      expect(resolveActive('gdansk', [])).toBe('');                                     // saved one gone
      expect(resolveActive('', [installed('gdansk', '2')])).toBe('gdansk');              // first installed
      expect(resolveActive('gdansk', [installed('krakow', '1'), installed('gdansk', '2')])).toBe('gdansk');
      expect(resolveActive('warsaw', [installed('krakow', '1'), installed('gdansk', '2')])).toBe('krakow');
      // the merged rows mark the resolved active course
      const rows = mergeCourses([installed('krakow', '1')], [course('krakow', '1')], 'gone');
      expect(rows[0].active).toBe(true);
    });

    it('firstDownloadBecomesActive', () => {
      expect(activeAfterInstall('', 'krakow')).toBe('krakow');
      expect(activeAfterInstall('krakow', 'gdansk')).toBe('krakow');   // later downloads do not switch
      expect(activeAfterInstall('krakow', 'krakow')).toBe('krakow');   // an update of the active course
    });

    it('deleteRules', () => {
      const list = [installed('gdansk', '2'), installed('warsaw', '1')];
      const d = afterDelete(list, 'gdansk', 'gdansk');
      expect(d.allowed).toBe(true);
      expect(d.installed.length).toBe(1);
      expect(d.activeId).toBe('warsaw');   // the active one was deleted: another installed course
      const d2 = afterDelete(list, 'warsaw', 'gdansk');
      expect(d2.activeId).toBe('gdansk');
      const d3 = afterDelete(list, 'krakow', 'gdansk');
      expect(d3.allowed).toBe(false);
      expect(d3.installed.length).toBe(2);
      // deleting the last (active) course: no course, Home goes back to the empty state
      const d4 = afterDelete([installed('krakow', '1')], 'krakow', 'krakow');
      expect(d4.allowed).toBe(true);
      expect(d4.installed.length).toBe(0);
      expect(d4.activeId).toBe('');
    });

    it('installReplacesOlderVersion', () => {
      const list = afterInstall([installed('gdansk', '1'), installed('warsaw', '1')], installed('gdansk', '2'));
      expect(list.length).toBe(2);
      expect(list.filter((i: InstalledCourse) => i.id === 'gdansk')[0].version).toBe('2');
    });

    it('homeModeEmptyState', () => {
      expect(homeMode(true, false, false)).toBe(HomeMode.LOADING);
      expect(homeMode(false, false, false)).toBe(HomeMode.NO_COURSE);   // first run: "Download your first walk"
      expect(homeMode(false, false, true)).toBe(HomeMode.NO_COURSE);
      expect(homeMode(false, true, true)).toBe(HomeMode.READY);
      expect(homeMode(false, true, false)).toBe(HomeMode.ERROR);       // installed but unreadable
    });

    it('demoWalkWhereverThePackHasATrack', () => {
      expect(demoWalkOffered('krakow', true)).toBe(true);
      expect(demoWalkOffered('gdansk', true)).toBe(true);          // any city, any course id
      expect(demoWalkOffered('krakow-scholars', false)).toBe(false);   // its pack ships no demo-walk.json
      expect(demoWalkOffered('', true)).toBe(false);               // no active course
      expect(demoWalkOffered('', false)).toBe(false);
    });

    it('cityPackDownloadAndCleanup', () => {
      expect(cityNeedsDownload('', '')).toBe(true);                // first course of the city, catalog unknown
      expect(cityNeedsDownload('', 'c1')).toBe(true);
      expect(cityNeedsDownload('c1', 'c1')).toBe(false);           // second course of the city: shared, no download
      expect(cityNeedsDownload('c1', 'c2')).toBe(true);            // the catalog has a newer city pack
      expect(cityNeedsDownload('c1', '')).toBe(false);             // offline / older catalog: keep the installed one
      // removal: only cities no remaining course uses
      expect(orphanCities(['krakow', 'gdansk'], ['krakow', 'krakow']).join(',')).toBe('gdansk');
      expect(orphanCities(['krakow'], ['krakow', '']).length).toBe(0);
      expect(orphanCities(['krakow'], ['']).join(',')).toBe('krakow');   // only a self-contained course left
      expect(orphanCities([], []).length).toBe(0);
      // the Download size includes the city pack only while that city is not installed
      expect(downloadBytes(1000, 'krakow', 9000, false)).toBe(10000);
      expect(downloadBytes(1000, 'krakow', 9000, true)).toBe(1000);
      expect(downloadBytes(1000, '', 9000, false)).toBe(1000);
      expect(downloadBytes(1000, 'krakow', 0, false)).toBe(1000);   // older catalog: size unknown
    });

    it('twoKrakowCourses', () => {
      // catalog order; the Royal Route installed and active, Scholars and Saints only on the server
      const cat = [course('krakow', '1'), course('krakow-scholars', '1')];
      expect(ids(mergeCourses([installed('krakow', '1')], cat, 'krakow'))).toBe('krakow:downloaded,krakow-scholars:available');
      // download it: the active course stays the Royal Route until the user selects the new one
      const both = afterInstall([installed('krakow', '1')], installed('krakow-scholars', '1'));
      expect(activeAfterInstall('krakow', 'krakow-scholars')).toBe('krakow');
      const rows = mergeCourses(both, cat, 'krakow-scholars');   // the user selected it
      expect(ids(rows)).toBe('krakow:downloaded,krakow-scholars:downloaded');
      expect(rows[1].active).toBe(true);
      expect(rows[0].active).toBe(false);
      // deleting the active Scholars course makes the Royal Route active again
      expect(afterDelete(both, 'krakow-scholars', 'krakow-scholars').activeId).toBe('krakow');
    });

    it('titlesSizesProgress', () => {
      const c = course('gdansk', '1');
      expect(courseTitle(c, 'pl')).toBe('gdansk pl');
      expect(courseTitle(c, 'zh')).toBe('gdansk en');   // no zh title: English
      c.title.en = '';
      c.title.pl = '';
      expect(courseTitle(c, 'en')).toBe('gdansk');
      expect(sizeLabel(12345678)).toBe('11.8 MB');
      expect(sizeLabel(2048)).toBe('2 KB');
      expect(sizeLabel(0)).toBe('');
      expect(progressPct(50, 200, 0, 0)).toBe(25);
      expect(progressPct(0, 0, 3, 4)).toBe(75);
      expect(progressPct(500, 200, 0, 0)).toBe(100);
      expect(progressPct(0, 0, 0, 0)).toBe(0);
    });
  });
}

courseRulesTest();
