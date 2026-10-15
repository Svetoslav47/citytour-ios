/*
 * Settings building blocks (task B9, DESIGN §3.11 and the mockup docs/design/mockups/Settings.dc.html): grouped
 * cards on bg.surface (radius lg), overline section headers, 56 pt single-line / 72 pt two-line rows, a hairline
 * divider inset 16 pt, a pill segmented control (sunken track, accent-subtle selection) and footnotes.
 * Screen-reader state: accessibilityState selected / checked.
 * Every interactive row is at least 48 pt tall, is one accessibility element and says what it does. Font sizes
 * follow the system font scale (React Native Text default); rows grow with their text.
 * SettingsFrame is the shared page shell of Settings and its sub-pages (safe areas, scroll, max width, header).
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';

const PRESSED_BG: string = '#8080801F';

export interface SettingsHeaderProps {
  title?: string;
  backId?: string;
  onBack?: () => void;
}

/** Back button + the large title (title1), as the other screens draw their own header. */
export function SettingsHeader({ title = '', backId = 'btnSettingsBack', onBack = () => {} }: SettingsHeaderProps):
  React.JSX.Element {
  const t = useT();
  const c = useColors();
  return (
    <View style={styles.header}>
      <View style={{ paddingLeft: Space.S1 }}>
        <Pressable
          testID={backId}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel={t('a11y_back')}
          onPress={() => onBack()}
        >
          <SymbolView name="chevron.backward" size={22} tintColor={c.text_primary} />
        </Pressable>
      </View>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text_primary }]}>{title}</Text>
    </View>
  );
}

export function SectionHeader({ label = '' }: { label?: string }): React.JSX.Element {
  const c = useColors();
  return <Text style={[styles.section, { color: c.text_secondary }]}>{label.toUpperCase()}</Text>;
}

/** A white card that groups rows (radius lg, clipped). */
export function SettingsCard({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const c = useColors();
  return <View style={[styles.card, { backgroundColor: c.bg_surface }]}>{children}</View>;
}

export function RowDivider(): React.JSX.Element {
  const c = useColors();
  return <View style={[styles.divider, { backgroundColor: c.divider }]} />;
}

export function Footnote({ text = '' }: { text?: string }): React.JSX.Element {
  const c = useColors();
  return <Text style={[styles.footnote, { color: c.text_secondary }]}>{text}</Text>;
}

export interface NavRowProps {
  title?: string;
  subtitle?: string;
  value?: string;
  rowId?: string;
  tappable?: boolean;
  busy?: boolean;
  onTap?: () => void;
  /** iOS addition: a hidden long-press action (Settings › About › Version opens the Developer page). */
  onLongPress?: () => void;
}

/** Title, optional subtitle, optional value and chevron. Tappable when `tappable`. */
export function NavRow({
  title = '', subtitle = '', value = '', rowId = '', tappable = true, busy = false, onTap = () => {}, onLongPress
}: NavRowProps): React.JSX.Element {
  const c = useColors();
  return (
    <Pressable
      testID={rowId !== '' ? rowId : undefined}
      accessible={true}
      accessibilityRole={tappable ? 'button' : undefined}
      accessibilityState={{ busy }}
      onPress={() => {
        if (tappable) {
          onTap();
        }
      }}
      onLongPress={onLongPress}
      delayLongPress={800}
      style={({ pressed }) => [styles.row, {
        minHeight: subtitle !== '' ? 72 : 56,
        paddingRight: tappable ? Space.S3 : Space.S4,
        backgroundColor: pressed && tappable ? PRESSED_BG : 'transparent'
      }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text_primary }]}>{title}</Text>
        {subtitle !== '' ? (
          <Text style={[styles.rowSub, TABULAR, { color: c.text_secondary }]}>{subtitle}</Text>
        ) : null}
      </View>
      {busy ? <ActivityIndicator size="small" color={c.accent} style={{ width: 20, height: 20 }} /> : null}
      {value !== '' ? (
        <Text style={[styles.rowValue, { color: c.text_secondary }]}>{value}</Text>
      ) : null}
      {tappable ? <SymbolView name="chevron.right" size={15} tintColor={c.text_tertiary} /> : null}
    </Pressable>
  );
}

export interface ToggleRowProps {
  title?: string;
  subtitle?: string;
  isOn?: boolean;
  rowId?: string;
  active?: boolean;
  onToggle?: (on: boolean) => void;
}

/** A switch row. The whole row toggles; disabled rows are greyed and say why in the subtitle. */
export function ToggleRow({
  title = '', subtitle = '', isOn = false, rowId = '', active = true, onToggle = () => {}
}: ToggleRowProps): React.JSX.Element {
  const c = useColors();
  return (
    <Pressable
      testID={rowId !== '' ? rowId : undefined}
      accessible={true}
      accessibilityRole="switch"
      accessibilityState={{ checked: isOn, disabled: !active }}
      onPress={() => {
        if (active) {
          onToggle(!isOn);
        }
      }}
      style={[styles.row, { minHeight: subtitle !== '' ? 72 : 56, gap: Space.S3 }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: active ? c.text_primary : c.text_tertiary }]}>{title}</Text>
        {subtitle !== '' ? <Text style={[styles.rowSub, { color: c.text_secondary }]}>{subtitle}</Text> : null}
      </View>
      {/* the row handles the tap (one target, no double toggle) */}
      <View pointerEvents="none">
        <Switch
          testID={`${rowId}Switch`}
          value={isOn}
          disabled={!active}
          trackColor={{ true: c.accent }}
        />
      </View>
    </Pressable>
  );
}

/** One option of a segmented row (key + label). */
export class SegmentOption {
  key: string;
  label: string;
  a11y: string;

  constructor(key: string, label: string, a11y?: string) {
    this.key = key;
    this.label = label;
    this.a11y = a11y !== undefined ? a11y : label;
  }
}

export interface SegmentRowProps {
  title?: string;
  options?: SegmentOption[];
  selected?: string;
  idPrefix?: string;
  onSelect?: (key: string) => void;
}

/** DESIGN §3.11 SegmentButton look: a sunken pill track, the selected option in accent on accent-subtle. */
export function SegmentRow({
  title = '', options = [], selected = '', idPrefix = 'seg', onSelect = () => {}
}: SegmentRowProps): React.JSX.Element {
  const c = useColors();
  return (
    <View style={styles.segWrap}>
      {title !== '' ? <Text style={[styles.rowTitle, { color: c.text_primary }]}>{title}</Text> : null}
      <View style={[styles.segTrack, { backgroundColor: c.bg_surface_sunken }]}>
        {options.map((o: SegmentOption) => {
          const on = o.key === selected;
          return (
            <Pressable
              key={o.key}
              testID={`${idPrefix}${o.key}`}
              style={styles.segItem}
              accessibilityRole="button"
              accessibilityLabel={o.a11y}
              accessibilityState={{ selected: on }}
              onPress={() => onSelect(o.key)}
            >
              <View style={[styles.segPill, { backgroundColor: on ? c.accent_subtle : 'transparent' }]}>
                <Text
                  numberOfLines={1}
                  style={[styles.segLabel, TABULAR, { color: on ? c.accent : c.text_secondary }]}
                >
                  {o.label}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export interface RadioRowProps {
  title?: string;
  subtitle?: string;
  selected?: boolean;
  rowId?: string;
  group?: string;
  onSelect?: () => void;
}

/** A radio row for the language and strategy sub-pages. */
export function RadioRow({
  title = '', subtitle = '', selected = false, rowId = '', onSelect = () => {}
}: RadioRowProps): React.JSX.Element {
  const c = useColors();
  return (
    <Pressable
      testID={rowId !== '' ? rowId : undefined}
      accessible={true}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      onPress={() => onSelect()}
      style={({ pressed }) => [styles.row, {
        minHeight: subtitle !== '' ? 72 : 56, gap: Space.S3, backgroundColor: pressed ? PRESSED_BG : 'transparent'
      }]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: c.text_primary }]}>{title}</Text>
        {subtitle !== '' ? <Text style={[styles.rowSub, { color: c.text_secondary }]}>{subtitle}</Text> : null}
      </View>
      <RadioMark selected={selected} />
    </Pressable>
  );
}

/** The radio glyph (HarmonyOS Radio look: a filled accent tick when checked, an empty ring otherwise). */
export function RadioMark({ selected, size = 24 }: { selected: boolean; size?: number }): React.JSX.Element {
  const c = useColors();
  return (
    <SymbolView
      name={selected ? 'checkmark.circle.fill' : 'circle'}
      size={size}
      tintColor={selected ? c.accent : c.text_tertiary}
    />
  );
}

export interface SettingsFrameProps {
  title: string;
  pageId: string;
  onBack: () => void;
  /** Gap between the page's sections (Settings and Voice use S5; the language pages have one section). */
  gap?: number;
  children?: React.ReactNode;
}

/**
 * The page shell every Settings screen shares: the canvas runs under the status bar, the scroll viewport starts
 * below it, and the end of the content clears the home indicator.
 */
export function SettingsFrame({ title, pageId, onBack, gap = 0, children }: SettingsFrameProps): React.JSX.Element {
  const c = useColors();
  const sa = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.bg_canvas, paddingTop: sa.top, paddingLeft: sa.left,
      paddingRight: sa.right }}>
      <ScrollView testID={pageId} showsVerticalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
        <View style={{ width: '100%', maxWidth: Size.PAGE_MAX_W }}>
          <SettingsHeader title={title} onBack={onBack} />
          <View style={{ width: '100%', gap, paddingHorizontal: Space.S4, paddingBottom: Space.S6 + sa.bottom }}>
            {children}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%', alignItems: 'flex-start' },
  back: { width: Size.TOUCH, height: Size.TOUCH, alignItems: 'center', justifyContent: 'center' },
  title: {
    fontSize: Type.TITLE1, lineHeight: Type.TITLE1_LH, fontWeight: '700',
    marginLeft: Space.S4, marginRight: Space.S4, marginTop: Space.S1, marginBottom: 20
  },
  section: {
    fontSize: Type.CAPTION, lineHeight: Type.CAPTION_LH, fontWeight: '500', letterSpacing: Type.OVERLINE_SPACING,
    paddingHorizontal: Space.S4, marginBottom: Space.S2, width: '100%'
  },
  card: { width: '100%', borderRadius: Radius.LG, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth * 2, marginHorizontal: Space.S4 },
  footnote: {
    fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH, paddingHorizontal: Space.S4, marginTop: Space.S2,
    width: '100%'
  },
  row: {
    width: '100%', flexDirection: 'row', alignItems: 'center', gap: Space.S2,
    paddingLeft: Space.S4, paddingRight: Space.S4, paddingTop: Space.S2, paddingBottom: Space.S2
  },
  rowText: { flex: 1, gap: 2, alignItems: 'flex-start' },
  rowTitle: { fontSize: Type.BODY, lineHeight: 22 },
  rowSub: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH },
  rowValue: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, textAlign: 'right', maxWidth: '55%' },
  segWrap: {
    width: '100%', gap: 10, alignItems: 'flex-start',
    paddingLeft: Space.S4, paddingRight: Space.S4, paddingTop: 14, paddingBottom: Space.S3
  },
  segTrack: { width: '100%', flexDirection: 'row', paddingHorizontal: Space.S1, borderRadius: 24 },
  segItem: { flex: 1, minHeight: Size.TOUCH, justifyContent: 'center' },
  segPill: { minHeight: 40, borderRadius: 20, justifyContent: 'center', paddingHorizontal: Space.S1 },
  segLabel: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, fontWeight: '500', textAlign: 'center' }
});
