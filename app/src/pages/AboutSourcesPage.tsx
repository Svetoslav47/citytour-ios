/*
 * About & licences (B8, DESIGN §3.15, ARCHITECTURE §7.1 licences, RISKS T14): the ONLY screen with attribution and
 * disclosure (the everyday screens stay clean; AI and sources are also presented in the pitch). In order: the full
 * credit of each downloaded course's cover photo (author, licence + link, Commons page, our changes;
 * data/ATTRIBUTION.md), map and data licences, the narration voice credit (ElevenLabs), one short paragraph on how
 * the stories are made (AI, machine translation), and the offline pack's version. Offline.
 * The Developer page's hidden entry is on Settings › About › Version (long press); this screen has none.
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from 'valtio';
import { courseTitle, coverSubject, LogEvents } from '@citytour/core';
import { AppContainer } from '@/app/AppContainer';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { CourseCoverCredit } from '@/services/remote/CourseRepository';
import { Radius, Size, Space, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { withTimeout } from '@/viewmodel/Async';
import { coverLang } from '@/viewmodel/CoverModel';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';

interface LicenceRow {
  title: string;
  note: string | undefined;
}

const LICENCES: LicenceRow[] = [
  { title: 'about_osm', note: undefined },
  { title: 'about_wikipedia', note: undefined },
  { title: 'about_wikidata', note: undefined },
  { title: 'about_arcgis', note: 'about_arcgis_terms' },
  { title: 'about_osrm', note: undefined }
];

export function AboutSourcesPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const app = AppViewModel.get();
  const a = useSnapshot(app);
  const [covers, setCovers] = useState<CourseCoverCredit[]>([]);

  useEffect(() => {
    let alive = true;
    try {
      withTimeout(AppContainer.courses().coverCredits(), 10000, [] as CourseCoverCredit[], 'about.coverCredits')
        .then((list: CourseCoverCredit[]) => {
          if (alive) {
            setCovers(list);
          }
        });
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AboutSourcesPage.covers ${Log.errKv(e)}`);
    }
    return () => {
      alive = false;
    };
  }, []);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, 'page=AboutSources shown');
  }, []));

  const lang = coverLang(a.textLang);

  const header = (key: string): React.JSX.Element => (
    <Text style={[styles.header, { color: c.text_secondary }]}>{t(key).toUpperCase()}</Text>
  );

  const card = (key: string, id: string): React.JSX.Element => (
    <Text testID={id} style={[styles.card, { color: c.text_primary, backgroundColor: c.bg_surface }]}>{t(key)}</Text>
  );

  const rowBorder = (idx: number): object => ({
    borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: c.divider
  });

  return (
    <View
      testID="pageAbout"
      style={{ flex: 1, backgroundColor: c.bg_canvas, paddingTop: sa.top, paddingBottom: sa.bottom,
        paddingLeft: sa.left, paddingRight: sa.right }}
    >
      <View style={styles.topBar}>
        <FloatingIconButton
          symbol="chevron.backward"
          label={t('a11y_back')}
          buttonId="btnBackAbout"
          onTap={() => app.back()}
        />
        <Text accessibilityRole="header" style={[styles.title, { color: c.text_primary }]}>{t('about_title')}</Text>
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}
        contentContainerStyle={{ alignItems: 'center' }}>
        <View style={styles.content}>
          {covers.length > 0 ? (
            <>
              {header('about_cover_title')}
              <View testID="aboutCovers" style={[styles.group, { backgroundColor: c.bg_surface }]}>
                {covers.map((cv: CourseCoverCredit, idx: number) => {
                  const subject = coverSubject(cv.credit, lang);
                  return (
                    <View key={cv.id} style={[styles.groupRow, rowBorder(idx)]}>
                      <Text style={[styles.body, { color: c.text_primary, fontWeight: '500' }]}>
                        {courseTitle(cv.summary, lang)}
                      </Text>
                      {subject !== '' ? (
                        <Text style={[styles.callout, { color: c.text_primary }]}>{subject}</Text>
                      ) : null}
                      <Text style={[styles.foot, { color: c.text_secondary }]}>
                        {t('cover_photo_credit', `${cv.credit.author}, ${cv.credit.license}`)}
                      </Text>
                      {cv.credit.licenseUrl !== '' ? (
                        <Text selectable={true} style={[styles.foot, { color: c.text_secondary }]}>
                          {t('about_cover_licence', cv.credit.licenseUrl)}
                        </Text>
                      ) : null}
                      {cv.credit.sourceUrl !== '' ? (
                        <Text selectable={true} style={[styles.foot, { color: c.text_secondary }]}>
                          {t('about_cover_source', cv.credit.publisher !== '' ? cv.credit.publisher :
                            'Wikimedia Commons', cv.credit.sourceUrl)}
                        </Text>
                      ) : null}
                      <Text style={[styles.foot, { color: c.text_secondary }]}>{t('about_cover_changes')}</Text>
                    </View>
                  );
                })}
              </View>
            </>
          ) : null}

          {header('about_data_title')}
          <View testID="aboutLicences" style={[styles.group, { backgroundColor: c.bg_surface }]}>
            {LICENCES.map((l: LicenceRow, idx: number) => (
              <View key={`${idx}`} style={[styles.groupRow, rowBorder(idx)]}>
                <Text style={[styles.body, { color: c.text_primary }]}>{t(l.title)}</Text>
                {l.note !== undefined ? (
                  <Text style={[styles.foot, { color: c.text_secondary }]}>{t(l.note)}</Text>
                ) : null}
              </View>
            ))}
          </View>

          {header('about_voice_title')}
          {card('about_voice_body', 'aboutVoice')}

          {header('about_ai_title')}
          {card('about_ai_body', 'aboutAi')}

          {a.packVersion !== '' ? (
            <>
              {header('about_pack_title')}
              <Text testID="aboutPack" style={[styles.pack, { color: c.text_secondary }]}>
                {t('about_pack_line', a.packVersion, a.packBuiltAt, a.packPois)}
              </Text>
            </>
          ) : null}
          <View style={{ height: Space.S6 }} />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: Space.S1, paddingLeft: Space.S2,
    paddingTop: Space.S2
  },
  title: { fontSize: Type.TITLE3, fontWeight: '500' },
  content: { width: '100%', maxWidth: Size.PAGE_MAX_W, paddingHorizontal: Space.S4, alignItems: 'flex-start' },
  header: {
    fontSize: Type.CAPTION, lineHeight: Type.CAPTION_LH, fontWeight: '500', letterSpacing: Type.OVERLINE_SPACING,
    marginLeft: Space.S1, marginTop: Space.S5, marginBottom: Space.S2
  },
  group: { width: '100%', paddingHorizontal: Space.S4, borderRadius: Radius.LG },
  groupRow: { width: '100%', gap: 2, paddingVertical: Space.S3, alignItems: 'flex-start' },
  body: { fontSize: Type.BODY, lineHeight: Type.BODY_LH },
  callout: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH },
  foot: { fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH },
  card: {
    fontSize: Type.BODY, lineHeight: Type.BODY_LH, width: '100%', padding: Space.S4, borderRadius: Radius.LG,
    overflow: 'hidden'
  },
  pack: { fontSize: Type.CALLOUT, paddingLeft: Space.S1 }
});
