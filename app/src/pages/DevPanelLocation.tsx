/*
 * DevPanel section for the location sources (task A5). Developer page: literal strings on purpose.
 * Buttons (testIDs):
 *   btnDemoWalkX8   start the SIMULATED Demo walk at x8 (the PLAN A5 verify step)
 *   btnDemoStart / btnDemoStop / btnDemoSpeed (cycle 1-2-4-8) / btnDemoJump (next stop) / btnDemoRewind
 *   btnDemoHold     toggles the hold predicate ("a story is playing"), to see the Demo assist hold
 *   btnRealStart    Real GPS (expo-location): permission dialog, Location Services check, then 1 Hz fixes
 *   btnRealStop / btnPermSettings (the app's Settings after a denial) / btnLocSwitch (Location Services)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Fix, FixSource, nextDemoSpeed, PermissionState } from '@citytour/core';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';

const AMBER: string = '#FFB000';

/** A plain developer button (the HarmonyOS default Button look: a capsule, literal label). */
export function DevButton({ id, label, onPress, flex = false, bg = '#0A59F7', fg = '#FFFFFF' }: {
  id: string; label: string; onPress: () => void; flex?: boolean; bg?: string; fg?: string;
}): React.JSX.Element {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [devStyles.btn, flex ? { flex: 1 } : { width: '100%' },
        { backgroundColor: bg, opacity: pressed ? 0.7 : 1 }]}
    >
      <Text numberOfLines={2} style={[devStyles.btnText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export const devStyles = StyleSheet.create({
  section: { width: '100%', gap: 8 },
  h2: { fontSize: 18, fontWeight: '500' },
  small: { fontSize: 12 },
  row: { width: '100%', flexDirection: 'row', gap: 8 },
  btn: {
    minHeight: 40, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8, alignItems: 'center',
    justifyContent: 'center'
  },
  btnText: { fontSize: 15, fontWeight: '500', textAlign: 'center' }
});

function fmtFix(f: Fix | undefined): string {
  if (f === undefined) {
    return 'no fix';
  }
  const crs = Number.isFinite(f.courseDeg) ? `${f.courseDeg.toFixed(0)}°` : '-';
  const digits = f.source === FixSource.REAL ? 4 : 6;
  return `${f.lat.toFixed(digits)}, ${f.lng.toFixed(digits)} ±${f.accuracyM.toFixed(0)} m ` +
    `${Number.isFinite(f.speedMps) ? f.speedMps.toFixed(2) : '-'} m/s crs ${crs}`;
}

export function LocationDevSection(): React.JSX.Element {
  const [permLine, setPermLine] = useState<string>('permission: ?');
  const [realLine, setRealLine] = useState<string>('Real GPS: stopped');
  const [realFix, setRealFix] = useState<string>('');
  const [demoLine, setDemoLine] = useState<string>('Demo walk: stopped');
  const [demoFix, setDemoFix] = useState<string>('');
  const [demoRunning, setDemoRunning] = useState<boolean>(false);
  const [demoSpeed, setDemoSpeed] = useState<number>(4);
  const [storyHold, setStoryHold] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const realLast = useRef<Fix | undefined>(undefined);
  const holdRef = useRef<boolean>(false);

  const refresh = useCallback((): void => {
    try {
      const perms = AppContainer.permissions();
      perms.locationState().then((s: PermissionState) => {
        setPermLine(`permission: ${s} | location switch: ${perms.isLocationSwitchOn() ? 'on' : 'OFF'}`);
      }).catch((e: unknown) => {
        setPermLine(`permission: error ${Log.errKv(e)}`);
      });
      const real = AppContainer.realLocation();
      const acc = real.lastAccuracyM();
      setRealLine(`Real GPS: ${real.isRunning() ? 'running' : 'stopped'} | fixes ${real.fixCount()}` +
        ` | acc ${Number.isFinite(acc) ? acc.toFixed(1) + ' m' : '-'}` +
        (real.lastError() !== '' ? ` | ${real.lastError()}` : ''));
      setRealFix(fmtFix(realLast.current));
      const demo = AppContainer.demoWalk();
      if (demo !== undefined) {
        setDemoRunning(demo.isRunning());
        setDemoSpeed(demo.speed());
        const stop = demo.currentStop();
        setDemoLine(`Demo walk: ${demo.isRunning() ? 'running' : (demo.isFinished() ? 'finished' : 'stopped')}` +
          ` | x${demo.speed()} | ${(demo.progress() * 100).toFixed(1)}%` +
          ` | ${stop > 0 ? 'at stop ' + stop : 'walking'}` +
          (demo.isHolding() ? ' | Demo assist: waiting at stop while the story plays' : '') +
          (demo.lastError() !== '' ? ` | ${demo.lastError()}` : ''));
        setDemoFix(fmtFix(demo.lastEmitted()));
      }
    } catch (e) {
      setNote(`refresh failed ${Log.errKv(e)}`);
    }
  }, []);

  useEffect(() => {
    const demo = AppContainer.demoWalk();
    if (demo !== undefined) {
      setDemoSpeed(demo.speed());
      demo.setHoldPredicate(() => holdRef.current);
    }
    refresh();
    const timer = setInterval(() => refresh(), 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const startDemo = (speed: number): void => {
    const demo = AppContainer.demoWalk();
    if (demo === undefined) {
      setNote('Demo walk unavailable (no context)');
      return;
    }
    if (speed > 0) {
      demo.setSpeed(speed);
    }
    demo.start((f: Fix) => {
      setDemoFix(fmtFix(f));
    }, (code: number, msg: string) => {
      setNote(`demo error ${code}: ${msg}`);
    }).then(() => refresh());
  };

  const startReal = (): void => {
    setNote('Real GPS: checking permission and Location Services...');
    AppContainer.realLocation().start((f: Fix) => {
      realLast.current = f;
    }, (code: number, msg: string) => {
      setNote(`real GPS error ${code}: ${msg}`);
    }).then(() => {
      refresh();
      if (AppContainer.realLocation().isRunning()) {
        setNote('Real GPS subscribed (best for navigation, 1 s)');
      }
    });
  };

  return (
    <View style={[devStyles.section, { alignItems: 'flex-start' }]}>
      <Text style={devStyles.h2}>Location (A5)</Text>
      {demoRunning ? (
        <Text testID="simulatedBadge" style={{
          fontSize: 14, fontWeight: '700', color: '#000000', backgroundColor: AMBER, paddingHorizontal: 10,
          paddingVertical: 4, borderRadius: 12, overflow: 'hidden'
        }}>SIMULATED LOCATION · Demo walk</Text>
      ) : null}
      <Text testID="locPerm" style={devStyles.small}>{permLine}</Text>
      <Text testID="locReal" style={devStyles.small}>{realLine}</Text>
      <Text testID="locRealFix" style={devStyles.small}>{realFix}</Text>
      <Text testID="locDemo" style={devStyles.small}>{demoLine}</Text>
      <Text testID="locDemoFix" style={devStyles.small}>{demoFix}</Text>
      <Text testID="locNote" style={devStyles.small}>{note}</Text>
      <DevButton id="btnDemoWalkX8" label="Demo walk x8 (SIMULATED)" bg={AMBER} fg="#000000"
        onPress={() => startDemo(8)} />
      <View style={devStyles.row}>
        <DevButton id="btnDemoStart" label="Demo start" flex={true} onPress={() => startDemo(0)} />
        <DevButton id="btnDemoStop" label="Demo stop" flex={true} onPress={() => {
          AppContainer.demoWalk()?.stop();
          refresh();
        }} />
      </View>
      <View style={devStyles.row}>
        <DevButton id="btnDemoSpeed" label={`Speed x${demoSpeed}`} flex={true} onPress={() => {
          const demo = AppContainer.demoWalk();
          if (demo !== undefined) {
            demo.setSpeed(nextDemoSpeed(demo.speed()));
            setDemoSpeed(demo.speed());
          }
        }} />
        <DevButton id="btnDemoJump" label="Next stop" flex={true} onPress={() => {
          AppContainer.demoWalk()?.jumpToNextStop();
          refresh();
        }} />
        <DevButton id="btnDemoRewind" label="Rewind" flex={true} onPress={() => {
          AppContainer.demoWalk()?.rewind();
          refresh();
        }} />
      </View>
      <DevButton id="btnDemoHold"
        label={storyHold ? 'Story playing: ON (demo holds at stops)' : 'Story playing: off'}
        onPress={() => {
          holdRef.current = !holdRef.current;
          setStoryHold(holdRef.current);
        }} />
      <View style={devStyles.row}>
        <DevButton id="btnRealStart" label="Real GPS start" flex={true} onPress={() => startReal()} />
        <DevButton id="btnRealStop" label="Real GPS stop" flex={true} onPress={() => {
          AppContainer.realLocation().stop();
          refresh();
        }} />
      </View>
      <View style={devStyles.row}>
        <DevButton id="btnPermSettings" label="Open settings" flex={true} onPress={() => {
          AppContainer.permissions().openLocationSettings().then((s: PermissionState) => {
            setNote(`after settings: ${s}`);
            refresh();
          });
        }} />
        <DevButton id="btnLocSwitch" label="Location switch" flex={true} onPress={() => {
          AppContainer.permissions().requestLocationSwitch().then((on: boolean) => {
            setNote(`location switch: ${on ? 'on' : 'still off'}`);
            refresh();
          });
        }} />
      </View>
    </View>
  );
}
