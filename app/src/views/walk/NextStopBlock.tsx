/*
 * "Where next, how far, which way" (DESIGN §3.6): overline, stop name (title2, 2 lines), the hero distance
 * (display 34 pt, tabular, max font scale 1.6) or the look phrase at a stop, the ETA, and the Look cue.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TABULAR, Type, useColors } from '@/theme';
import { LookCue } from './LookCue';

export interface NextStopBlockProps {
  overline?: string;
  title?: string;
  /** Hero text: a distance ("180 m"), "—" with no GPS, or '' to hide. */
  hero?: string;
  /** True when the hero is the look phrase (title3 instead of display). */
  heroIsPhrase?: boolean;
  approx?: boolean;
  sub?: string;
  dim?: boolean;
  showCue?: boolean;
  angleDeg?: number;
  relDir?: string;
  lookUp?: boolean;
  landmark?: string;
  emphasised?: boolean;
}

export function NextStopBlock({
  overline = '', title = '', hero = '', heroIsPhrase = false, approx = false, sub = '', dim = false,
  showCue = true, angleDeg = Number.NaN, relDir = 'here', lookUp = false, landmark = '', emphasised = false
}: NextStopBlockProps): React.JSX.Element {
  const c = useColors();
  return (
    <View accessible={true} style={styles.root}>
      <Text testID="walkOverline" style={[styles.overline, { color: c.text_secondary }]}>{overline}</Text>
      <Text testID="walkTitle" numberOfLines={2} style={[styles.title, { color: c.text_primary }]}>{title}</Text>

      <View style={styles.row}>
        <View style={styles.left}>
          {hero !== '' ? (
            <Text
              testID="walkHero"
              maxFontSizeMultiplier={1.6}
              style={[TABULAR, {
                fontSize: heroIsPhrase ? Type.TITLE3 : Type.DISPLAY,
                lineHeight: heroIsPhrase ? Type.TITLE3_LH : Type.DISPLAY_LH,
                fontWeight: heroIsPhrase ? '500' : '700',
                color: dim ? c.text_secondary : c.text_primary
              }]}
            >
              {approx ? '~' : ''}
              {hero}
            </Text>
          ) : null}
          {sub !== '' ? <Text style={[styles.sub, { color: c.text_secondary }]}>{sub}</Text> : null}
        </View>

        {showCue ? (
          <LookCue
            angleDeg={angleDeg}
            relDir={relDir}
            lookUp={lookUp}
            landmark={landmark}
            emphasised={emphasised}
            dim={dim}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'flex-start',
    width: '100%',
    gap: 2
  },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  title: {
    fontSize: Type.TITLE2,
    lineHeight: Type.TITLE2_LH,
    fontWeight: '700'
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    width: '100%',
    marginTop: 6
  },
  left: {
    flex: 1,
    alignItems: 'flex-start',
    gap: 2
  },
  sub: {
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  }
});
