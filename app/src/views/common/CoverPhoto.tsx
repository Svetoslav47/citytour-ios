/*
 * A tour cover photo (core/remote/CoverRules): full-bleed Image (contentFit cover, decoded off the UI thread),
 * and, with a title, a dark gradient at the bottom with the title on the photo. The photo credit (CC BY-SA:
 * author, licence, source) lives in Settings -> About, not on the photo. While the file loads, or when it
 * cannot be decoded, a neutral placeholder fills the same box, so the layout never jumps.
 * The gradient is black in both themes: the photo is the same picture in light and dark mode, and white text on it
 * needs the same contrast either way.
 */
import { LogEvents } from '@citytour/core';
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { Space, Type, useColors } from '@/theme';

function uriOf(path: string): string {
  if (path === '') {
    return '';
  }
  return path.startsWith('file://') ? path : `file://${path}`;
}

export interface CoverPhotoProps {
  /** Absolute path of the JPEG; '' = placeholder only (still loading). */
  path?: string;
  /** Alt text: what the photo shows (default: the about_cover_title string). */
  alt?: string;
  /** Optional title drawn on the photo (Tour detail hero). */
  title?: string;
  /** Fixed height in points; 0 = follow `ratio` (width / height). */
  boxHeight?: number;
  ratio?: number;
  /** Left/right (and, with a title, bottom) padding of the text on the photo. */
  textPadding?: number;
  photoId?: string;
}

export function CoverPhoto({
  path = '', alt, title = '', boxHeight = 0, ratio = 16 / 10, textPadding = Space.S4, photoId = ''
}: CoverPhotoProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    setFailed(false);
  }, [path]);

  const sizeStyle = boxHeight > 0 ? { height: boxHeight } : ratio > 0 ? { aspectRatio: ratio } : { height: 0 };
  const showPhoto = path !== '' && !failed;

  return (
    <View
      testID={photoId !== '' ? photoId : undefined}
      style={[styles.box, sizeStyle]}
      accessible={true}
      accessibilityRole="image"
      accessibilityLabel={title !== '' ? title : (alt ?? t('about_cover_title'))}
    >
      {/* Placeholder (loading or undecodable): the sunken surface colour, same box. */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg_surface_sunken }]} />
      {showPhoto ? (
        <Image
          source={{ uri: uriOf(path) }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          accessibilityLabel={alt ?? t('about_cover_title')}
          onError={(e) => {
            setFailed(true);
            Log.w(LogEvents.COURSE, `event=cover_decode_fail msg=${e.error} fallback=placeholder`);
          }}
        />
      ) : null}
      {showPhoto && title !== '' ? (
        <View
          style={[styles.scrim, {
            paddingLeft: textPadding,
            paddingRight: textPadding,
            paddingBottom: textPadding
          }]}
        >
          <Text style={styles.title} numberOfLines={2} ellipsizeMode="tail">{title}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    overflow: 'hidden',
    justifyContent: 'flex-end'
  },
  scrim: {
    width: '100%',
    alignItems: 'flex-start',
    paddingTop: 48,
    experimental_backgroundImage:
      'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.35) 55%, rgba(0,0,0,0) 100%)'
  },
  title: {
    fontSize: Type.TITLE1,
    lineHeight: Type.TITLE1_LH,
    fontWeight: '700',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 1 }
  }
});
