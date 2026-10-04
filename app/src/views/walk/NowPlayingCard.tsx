/*
 * "What am I hearing" (DESIGN §3.6): waveform glyph + story title, the current sentence (transcript 18 pt,
 * 3 lines), a thin progress bar through the sentences, and the teaser chip when walking past a stop.
 * Reading mode (Polish text-only) shows the full transcript at 20 pt instead.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Radius, Space, Type, useColors } from '@/theme';

export interface NowPlayingCardProps {
  title?: string;
  caption?: string;
  sentenceIndex?: number;
  sentenceCount?: number;
  playing?: boolean;
  teaser?: boolean;
  reading?: boolean;
}

export function NowPlayingCard({
  title = '', caption = '', sentenceIndex = 0, sentenceCount = 0, playing = true, teaser = false, reading = false
}: NowPlayingCardProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const progress = sentenceCount > 0 ? Math.min(sentenceCount, sentenceIndex + 1) / sentenceCount : 0;
  return (
    <View testID="cardNowPlaying" accessible={true} style={[styles.card, { backgroundColor: c.bg_surface_sunken }]}>
      <View style={styles.titleRow}>
        <SymbolView name="waveform" size={18} tintColor={playing ? c.accent : c.text_tertiary} />
        <Text numberOfLines={1} style={[styles.title, { color: c.text_primary }]}>
          {title !== '' ? title : t('walk_now_playing')}
        </Text>
      </View>

      <Text
        testID="walkCaption"
        selectable={true}
        numberOfLines={reading ? 40 : 3}
        style={{
          width: '100%',
          fontSize: reading ? 20 : Type.TRANSCRIPT,
          lineHeight: reading ? 30 : Type.TRANSCRIPT_LH,
          color: c.text_primary
        }}
      >
        {caption}
      </Text>

      {sentenceCount > 1 ? (
        <View style={[styles.track, { backgroundColor: c.divider }]}>
          <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: c.accent }]} />
        </View>
      ) : null}
      {teaser ? (
        <Text style={[styles.teaser, { color: c.accent, backgroundColor: c.accent_subtle }]}>
          {t('walk_short_version')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'flex-start',
    width: '100%',
    gap: Space.S2,
    padding: Space.S4,
    borderRadius: Radius.LG
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2,
    width: '100%'
  },
  title: {
    flex: 1,
    fontSize: Type.BODY,
    fontWeight: '500'
  },
  track: {
    width: '100%',
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden'
  },
  fill: {
    height: 3,
    borderRadius: 1.5
  },
  teaser: {
    fontSize: Type.CAPTION,
    fontWeight: '500',
    paddingLeft: 10,
    paddingRight: 10,
    paddingTop: 4,
    paddingBottom: 4,
    borderRadius: Radius.SM,
    overflow: 'hidden'
  }
});
