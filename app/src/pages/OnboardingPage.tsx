/*
 * Onboarding, 3 steps (task A12, DESIGN §3.1, Flow A §2.3; mockups docs/design/mockups/Onboarding{1,2,3}.dc.html).
 * 1 "Your guide fits in your pocket": the Royal Route from the active course with plaques 1, 5, 11 and headphones
 *   (just the headphones on first run: the app ships no built-in course).
 * 2 "How should the guide speak?": English / 中文 / Polski with the real voice status and Play a sample.
 * 3 "Two permissions, and why": Location and Notifications, each Allow opens the system UI (expo-location /
 *   expo-notifications through the view model).
 * A pager with swiping disabled and custom dots (button driven, so no accidental swipe during a system dialog).
 * First-run root content (the root index renders it with asRoute=false); also the route '/Onboarding' that
 * Settings › Show intro opens (asRoute=true).
 * iOS port: the built-in system voice is dropped, so the English row's "Download English voice" button, its
 * progress bar and the download-failed line (btnOnbDownloadVoice, txtOnbDownloadFailed) are not ported.
 */
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import { SymbolView } from 'expo-symbols';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { proxy, useSnapshot } from 'valtio';
import { EnVoiceRow, Lang, LocRow, NotifRow, ONB_STEP_PERMS, ONB_STEPS } from '@citytour/core';
import { useT } from '@/platform/strings';
import { Palette, Radius, Size, Space, Type, useColors } from '@/theme';
import { AppViewModel, PackState } from '@/viewmodel/AppViewModel';
import { OnboardingViewModel } from '@/viewmodel/OnboardingViewModel';
import { Plaque, PlaqueState } from '@/views/common/Plaque';
import { PreviewPoint } from '@/views/common/RoutePreview';
import { RadioMark } from '@/views/settings/SettingsRows';

const VISUAL_W: number = 200;
const VISUAL_H: number = 240;
const VISUAL_PAD: number = 30;

interface VisualPoint {
  x: number;
  y: number;
  n: number;
}

function fitPoints(points: readonly PreviewPoint[]): VisualPoint[] {
  const out: VisualPoint[] = [];
  if (points.length === 0) {
    return out;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((VISUAL_W - 2 * VISUAL_PAD) / spanX, (VISUAL_H - 2 * VISUAL_PAD) / spanY);
  const offX = (VISUAL_W - spanX * scale) / 2;
  const offY = (VISUAL_H - spanY * scale) / 2;
  for (const p of points) {
    out.push({ x: offX + (p.x - minX) * scale, y: offY + (maxY - p.y) * scale, n: p.n });   // north up
  }
  return out;
}

/** Plaques 1, 5 and the last stop, as in the mockup. */
function shownPlaques(pts: VisualPoint[]): VisualPoint[] {
  if (pts.length === 0) {
    return [];
  }
  const out: VisualPoint[] = [pts[0]];
  if (pts.length > 5) {
    out.push(pts[4]);
  }
  if (pts.length > 1) {
    out.push(pts[pts.length - 1]);
  }
  return out;
}

function Headphones({ c, x, y, shadow }: { c: Palette; x: number; y: number; shadow: boolean }): React.JSX.Element {
  return (
    <View style={[styles.headphones, { left: x, top: y, backgroundColor: c.bg_surface }, shadow ? styles.shadow : null]}>
      <SymbolView name="headphones" size={28} tintColor={c.text_primary} />
    </View>
  );
}

function RouteVisual({ preview, c, label }: { preview: readonly PreviewPoint[]; c: Palette; label: string }):
  React.JSX.Element {
  const pts = useMemo(() => fitPoints(preview), [preview]);
  const path = useMemo(() => {
    const p = Skia.Path.Make();
    pts.forEach((v: VisualPoint, i: number) => {
      if (i === 0) {
        p.moveTo(v.x, v.y);
      } else {
        p.lineTo(v.x, v.y);
      }
    });
    return p;
  }, [pts]);
  return (
    <View
      style={[styles.visual, { backgroundColor: c.map_land }]}
      accessible={true}
      accessibilityLabel={label}
    >
      {preview.length > 1 ? (
        <>
          <Canvas style={StyleSheet.absoluteFill}>
            <Path path={path} style="stroke" strokeWidth={9} strokeJoin="round" strokeCap="round"
              color={c.bg_surface} />
            <Path path={path} style="stroke" strokeWidth={5} strokeJoin="round" strokeCap="round" color={c.accent} />
          </Canvas>
          {shownPlaques(pts).map((p: VisualPoint, idx: number) => (
            <View key={`${p.n}`} style={{ position: 'absolute', left: p.x - (idx === 0 ? 17 : 14),
              top: p.y - (idx === 0 ? 17 : 14) }}>
              <Plaque n={p.n} state={idx === 0 ? PlaqueState.NEXT : PlaqueState.UPCOMING} />
            </View>
          ))}
          <Headphones
            c={c}
            shadow={true}
            x={Math.min(VISUAL_W - Size.TOUCH - 4, Math.max(4, pts[0].x - 66))}
            y={Math.min(VISUAL_H - Size.TOUCH - 4, Math.max(4, pts[0].y - 14))}
          />
        </>
      ) : (
        <Headphones c={c} shadow={false} x={(VISUAL_W - Size.TOUCH) / 2} y={(VISUAL_H - Size.TOUCH) / 2} />
      )}
    </View>
  );
}

export interface OnboardingPageProps {
  /** true when opened from Settings as a route; false as the first-run root. */
  asRoute?: boolean;
}

export function OnboardingPage({ asRoute = false }: OnboardingPageProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const vm = useMemo(() => proxy(new OnboardingViewModel()), []);
  const s = useSnapshot(vm);
  const app = AppViewModel.get();
  const a = useSnapshot(app);
  const pager = useRef<ScrollView>(null);
  const voiceScroller = useRef<ScrollView>(null);
  const [pageW, setPageW] = useState<number>(0);

  useEffect(() => {
    vm.start(asRoute);
    vm.refreshPreview();
    return () => {
      vm.stop();
    };
  }, [vm, asRoute]);

  useEffect(() => {
    if (a.packState === PackState.READY) {
      vm.refreshPreview();
    }
  }, [a.packState, vm]);

  /** The sample caption sits below Play a sample: bring it into view (it is the only output for Polish). */
  useEffect(() => {
    if (s.sampleText !== '') {
      const h = setTimeout(() => {
        try {
          voiceScroller.current?.scrollToEnd({ animated: true });
        } catch {
          // scrolling is cosmetic
        }
      }, 50);
      return () => clearTimeout(h);
    }
    return undefined;
  }, [s.sampleText]);

  useEffect(() => {
    if (pageW > 0) {
      pager.current?.scrollTo({ x: s.step * pageW, animated: true });
    }
  }, [s.step, pageW]);

  const onPagerLayout = (e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    if (w > 0 && w !== pageW) {
      setPageW(w);
    }
  };

  // ---------- shared pieces ----------

  const title = (key: string, center: boolean): React.JSX.Element => (
    <Text accessibilityRole="header"
      style={[styles.title, { color: c.text_primary, textAlign: center ? 'center' : 'left' }]}>{t(key)}</Text>
  );

  const body = (key: string, center: boolean): React.JSX.Element => (
    <Text style={[styles.body, { color: c.text_secondary, textAlign: center ? 'center' : 'left' }]}>{t(key)}</Text>
  );

  const callout = (text: string): React.JSX.Element => (
    <Text style={[styles.callout, { color: c.text_secondary }]}>{text}</Text>
  );

  const divider = (indent: number): React.JSX.Element => (
    <View style={[styles.divider, { marginLeft: indent, backgroundColor: c.divider }]} />
  );

  // ---------- step 1 ----------

  const stepIntro = (
    <ScrollView showsVerticalScrollIndicator={false}
      contentContainerStyle={{ alignItems: 'center', paddingTop: 20, paddingBottom: Space.S4 }}>
      <RouteVisual preview={s.preview} c={c} label={t('onb_visual_a11y')} />
      <View style={{ gap: Space.S3, paddingHorizontal: 28, paddingTop: 40, width: '100%' }}>
        {title('onb1_title', true)}
        {body('onb1_body', true)}
      </View>
    </ScrollView>
  );

  // ---------- step 2 ----------

  const enRow = s.enRow();
  let enSubtitle: React.JSX.Element;
  if (enRow === EnVoiceRow.CHECKING) {
    enSubtitle = (
      <View style={styles.inlineRow}>
        <ActivityIndicator size="small" color={c.text_secondary} style={{ width: 16, height: 16 }} />
        {callout(t('onb_checking_voice'))}
      </View>
    );
  } else if (enRow === EnVoiceRow.TEXT_ONLY && !s.studio(Lang.EN)) {
    enSubtitle = callout(t('voice_text_only_platform'));
  } else {
    // Which voice speaks (pre-recorded or the server's studio voice) is not labelled here; see Settings > About.
    enSubtitle = callout(t('onb_spoken'));
  }

  const plStudio = s.studio(Lang.PL);

  const langRow = (id: string, lang: Lang, name: string, sub: React.ReactNode, a11y: string, padBottom: number):
    React.JSX.Element => (
    <Pressable
      testID={id}
      accessible={true}
      accessibilityRole="radio"
      accessibilityLabel={`${name}, ${a11y}`}
      accessibilityState={{ selected: s.selected === lang, checked: s.selected === lang }}
      onPress={() => vm.select(lang)}
      style={[styles.langRow, { paddingBottom: padBottom }]}
    >
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Text style={[styles.langName, { color: c.text_primary }]}>{name}</Text>
        <View style={{ marginTop: 2 }}>{sub}</View>
      </View>
      <View style={{ marginTop: 2 }}>
        <RadioMark selected={s.selected === lang} size={22} />
      </View>
    </Pressable>
  );

  const stepVoice = (
    <ScrollView ref={voiceScroller} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: Space.S4 }}>
      <View style={{ gap: Space.S2, paddingHorizontal: Space.S4, paddingTop: Space.S4 }}>
        {title('onb2_title', false)}
        {body('onb2_body', false)}
      </View>

      <View style={{ paddingHorizontal: Space.S4, marginTop: Space.S5 }}>
        <View style={[styles.cardGroup, { backgroundColor: c.bg_surface }]} accessibilityLabel={t('onb_lang_group')}>
          {/* English: real voice status from VoiceManager */}
          {langRow('rowOnbLangEn', Lang.EN, t('lang_english'), enSubtitle, t('lang_en_spoken'), Space.S4)}
          {divider(Space.S4)}
          {/* 中文 */}
          {langRow('rowOnbLangZh', Lang.ZH, t('lang_chinese'),
            callout(s.studio(Lang.ZH) || s.zhSpoken() ? t('onb_spoken') : t('voice_text_only_platform')),
            t('lang_zh_spoken'), 14)}
          {divider(Space.S4)}
          {/* Polski: spoken when the A13 clips ship, else text only */}
          {langRow('rowOnbLangPl', Lang.PL, t('lang_polish'),
            plStudio ? callout(t('onb_spoken')) : (
              <View style={[styles.inlineRow, { gap: 6 }]}>
                {callout(t('voice_text_only'))}
                <SymbolView name="info.circle" size={16} tintColor={c.text_secondary} />
              </View>
            ),
            plStudio ? t('lang_pl_spoken') : t('lang_pl_text'), 14)}
        </View>
      </View>

      {!plStudio ? (
        <View style={styles.plNote}>
          <View style={{ marginTop: 1 }} importantForAccessibility="no" accessibilityElementsHidden={true}>
            <SymbolView name="info.circle" size={16} tintColor={c.text_secondary} />
          </View>
          <Text style={[styles.foot, { color: c.text_secondary, flex: 1 }]}>{t('lang_pl_footnote')}</Text>
        </View>
      ) : null}

      <View style={{ gap: Space.S2, alignItems: 'flex-start', paddingHorizontal: Space.S4, paddingTop: Space.S4 }}>
        <Pressable
          testID="btnOnbSample"
          accessibilityRole="button"
          accessibilityState={{ disabled: !s.sampleAllowed() }}
          disabled={!s.sampleAllowed()}
          onPress={() => {
            vm.playSample();
          }}
          style={[styles.sampleBtn, { backgroundColor: c.bg_overlay_button, opacity: s.sampleAllowed() ? 1 : 0.4 }]}
        >
          <SymbolView name={s.samplePlaying ? 'waveform' : 'speaker.wave.2'} size={20} tintColor={c.accent} />
          <Text style={[styles.btnText, { color: c.accent }]}>{t('onb_play_sample')}</Text>
        </Pressable>
        {s.sampleText !== '' ? (
          <Text
            testID="txtOnbSample"
            style={[styles.sample, { color: s.samplePlaying ? c.text_primary : c.text_secondary }]}
          >
            {`“${s.sampleText}”`}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );

  // ---------- step 3 ----------

  const smallAction = (label: string, id: string, busy: boolean, action: () => void): React.JSX.Element => {
    if (busy) {
      return <ActivityIndicator size="small" color={c.accent} style={{ width: 24, height: 24, marginTop: 2 }} />;
    }
    return (
      <Pressable testID={id} accessibilityRole="button" accessibilityLabel={label} onPress={action}
        style={styles.smallAction}>
        <View style={[styles.smallPill, { backgroundColor: c.bg_overlay_button }]}>
          <Text style={[styles.smallText, { color: c.accent }]}>{label}</Text>
        </View>
      </Pressable>
    );
  };

  const allowed = (
    <View style={[styles.inlineRow, { gap: 6, height: 28 }]}>
      <SymbolView name="checkmark.circle.fill" size={20} tintColor={c.accent} />
      <Text style={[styles.callout, { color: c.accent, fontWeight: '500' }]}>{t('onb_allowed')}</Text>
    </View>
  );

  const note = (key: string, id: string): React.JSX.Element => (
    <Text testID={id} style={[styles.foot, { color: c.text_primary, marginTop: Space.S1 }]}>{t(key)}</Text>
  );

  const permRow = (id: string, symbol: 'location' | 'bell', titleKey: string, bodyKey: string,
    extra: React.ReactNode, action: React.ReactNode): React.JSX.Element => (
    <View testID={id} style={styles.permRow}>
      <View style={{ marginTop: 2, width: 32, alignItems: 'center' }}>
        <SymbolView name={symbol} size={28} tintColor={c.accent} />
      </View>
      <View style={{ flex: 1, gap: 2, alignItems: 'flex-start' }}>
        <Text style={[styles.langName, { color: c.text_primary }]}>{t(titleKey)}</Text>
        <Text style={[styles.callout, { color: c.text_secondary }]}>{t(bodyKey)}</Text>
        {extra}
      </View>
      {action}
    </View>
  );

  const locNote = s.loc === LocRow.SWITCH_OFF ? note('err_loc_switch_off', 'txtOnbLocNote') :
    s.loc === LocRow.APPROX ? note('err_perm_approx', 'txtOnbLocNote') :
      s.loc === LocRow.DENIED ? note('err_perm_denied', 'txtOnbLocNote') : null;
  const locAction = s.loc === LocRow.ALLOWED ? allowed :
    smallAction(s.loc === LocRow.SWITCH_OFF || s.loc === LocRow.APPROX ? t('err_perm_turn_on') : t('onb_allow'),
      'btnOnbAllowLocation', s.locBusy, () => {
        vm.allowLocation();
      });
  const notifAction = s.notif === NotifRow.ALLOWED ? allowed :
    s.notif === NotifRow.ASK ? smallAction(t('onb_allow'), 'btnOnbAllowNotif', s.notifBusy, () => {
      vm.allowNotifications();
    }) : null;

  const stepPermissions = (
    <ScrollView showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: Space.S4, paddingBottom: Space.S4, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: Space.S4, width: '100%' }}>{title('onb3_title', false)}</View>
      <View style={[styles.cardGroup, { backgroundColor: c.bg_surface, marginTop: 28, maxWidth: Size.PAGE_MAX_W }]}>
        {permRow('rowOnbLocation', 'location', 'onb_loc_title', 'onb_loc_body', locNote, locAction)}
        {divider(62)}
        {permRow('rowOnbNotifications', 'bell', 'onb_notif_title', 'onb_notif_body',
          s.notif === NotifRow.DENIED ? note('err_notif_denied', 'txtOnbNotifNote') : null, notifAction)}
      </View>
      <Text style={[styles.foot, { color: c.text_secondary, paddingHorizontal: Space.S1, marginTop: Space.S3 }]}>
        {t('onb_footer')}
      </Text>
    </ScrollView>
  );

  // ---------- frame ----------

  const perms = s.step === ONB_STEP_PERMS;
  const steps = [stepIntro, stepVoice, stepPermissions];

  return (
    <View
      testID="pageOnboarding"
      style={{ flex: 1, backgroundColor: c.bg_canvas, paddingTop: sa.top, paddingBottom: sa.bottom,
        paddingLeft: sa.left, paddingRight: sa.right }}
    >
      <View style={styles.skipBar}>
        <Pressable testID="btnOnbSkip" accessibilityRole="button" accessibilityLabel={t('onb_skip_a11y')}
          onPress={() => vm.finish('skip')} style={styles.skip}>
          <Text style={[styles.btnText, { color: c.text_secondary }]}>{t('onb_skip')}</Text>
        </Pressable>
      </View>

      <ScrollView
        testID="onbSwiper"
        ref={pager}
        horizontal={true}
        pagingEnabled={true}
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        style={{ flex: 1 }}
        onLayout={onPagerLayout}
      >
        {steps.map((node: React.JSX.Element, i: number) => (
          <View key={i} style={{ width: pageW > 0 ? pageW : 1, height: '100%' }}
            importantForAccessibility={i === s.step ? 'auto' : 'no-hide-descendants'}
            accessibilityElementsHidden={i !== s.step}>
            {node}
          </View>
        ))}
      </ScrollView>

      <View style={[styles.footer, { gap: perms ? Space.S2 : Space.S5 }]}>
        <View testID="onbDots" style={styles.dots} accessible={true}
          accessibilityLabel={t('onb_step_a11y', s.step + 1, ONB_STEPS)}>
          {[0, 1, 2].map((i: number) => (
            <View key={i} style={{
              width: i === s.step ? 18 : 6, height: 6, borderRadius: 3,
              backgroundColor: i === s.step ? c.accent : c.text_tertiary, opacity: i === s.step ? 1 : 0.38
            }} />
          ))}
        </View>
        {perms ? <View style={{ height: Space.S4 }} /> : null}
        <Pressable testID="btnOnbNext" accessibilityRole="button" onPress={() => vm.next()}
          style={({ pressed }) => [styles.primary, { backgroundColor: c.accent, opacity: pressed ? 0.85 : 1 }]}>
          <Text style={[styles.btnText, { color: c.on_accent }]}>{perms ? t('onb_done') : t('cta_continue')}</Text>
        </Pressable>
        {perms ? (
          <Pressable testID="btnOnbLater" accessibilityRole="button" onPress={() => vm.finish('later')}
            style={styles.later}>
            <Text style={[styles.btnText, { color: c.accent }]}>{t('onb_later')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  visual: { width: VISUAL_W, height: VISUAL_H, borderRadius: Radius.LG, overflow: 'hidden' },
  headphones: {
    position: 'absolute', width: Size.TOUCH, height: Size.TOUCH, borderRadius: Size.TOUCH / 2,
    alignItems: 'center', justifyContent: 'center'
  },
  shadow: {
    shadowColor: '#000000', shadowOpacity: 0.1, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }
  },
  title: { fontSize: Type.TITLE1, lineHeight: Type.TITLE1_LH, fontWeight: '700', width: '100%' },
  body: { fontSize: Type.BODY, lineHeight: Type.BODY_LH, width: '100%' },
  callout: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH },
  foot: { fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH },
  divider: { height: 1 },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: Space.S2 },
  cardGroup: { width: '100%', borderRadius: Radius.LG, overflow: 'hidden' },
  langRow: {
    width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: Space.S3, minHeight: Size.TOUCH,
    paddingLeft: Space.S4, paddingRight: Space.S4, paddingTop: 14
  },
  langName: { fontSize: Type.BODY, lineHeight: Type.BODY_LH, fontWeight: '500' },
  plNote: {
    width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: Space.S2, paddingHorizontal: 20,
    marginTop: Space.S3
  },
  sampleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: Space.S2, height: Size.BUTTON_H, borderRadius: Size.BUTTON_H / 2,
    paddingLeft: Space.S4, paddingRight: 20
  },
  btnText: { fontSize: Type.BODY, fontWeight: '500' },
  sample: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, fontStyle: 'italic', paddingHorizontal: Space.S1 },
  smallAction: { height: Size.TOUCH, paddingLeft: Space.S2, marginTop: -8, justifyContent: 'center' },
  smallPill: { height: 32, borderRadius: 16, paddingHorizontal: Space.S4, justifyContent: 'center' },
  smallText: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, fontWeight: '500' },
  permRow: { width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: 14, padding: Space.S4 },
  skipBar: {
    width: '100%', height: Size.TOUCH, flexDirection: 'row', justifyContent: 'flex-end', paddingRight: Space.S1
  },
  skip: { height: Size.TOUCH, paddingHorizontal: Space.S4, justifyContent: 'center' },
  footer: {
    width: '100%', maxWidth: Size.PAGE_MAX_W, alignSelf: 'center', paddingHorizontal: Space.S4,
    paddingTop: Space.S3, paddingBottom: Space.S5
  },
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center', height: 16, width: '100%' },
  primary: {
    width: '100%', height: Size.BUTTON_H, borderRadius: Size.BUTTON_H / 2, alignItems: 'center',
    justifyContent: 'center'
  },
  later: { width: '100%', height: Size.TOUCH, alignItems: 'center', justifyContent: 'center' }
});
