/*
 * Replacement for ArkUI PersistenceV2.connect(Class, key, factory): one observable instance per key whose fields
 * are saved to AsyncStorage on every change. AsyncStorage is asynchronous, so hydratePersistence() reads every key
 * once at app start (before the first screen renders) and connect() is then synchronous like on HarmonyOS.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { proxy, subscribe } from 'valtio';
import { Log } from '../app/Log';

const PREFIX: string = 'citytour.persist.';
const cache: Map<string, Record<string, unknown>> = new Map();
const instances: Map<string, object> = new Map();
let hydrated: boolean = false;

export async function hydratePersistence(): Promise<void> {
  if (hydrated) {
    return;
  }
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [k, v] of pairs) {
      if (v !== null) {
        try {
          cache.set(k.slice(PREFIX.length), JSON.parse(v) as Record<string, unknown>);
        } catch (e) {
          Log.e('UNCAUGHT', `where=Persist.parse key=${k} ${Log.errKv(e)}`);
        }
      }
    }
  } catch (e) {
    Log.e('UNCAUGHT', `where=Persist.hydrate ${Log.errKv(e)}`);
  }
  hydrated = true;
}

function plainFields(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v !== 'function') {
      out[k] = v;
    }
  }
  return out;
}

/** The persisted, observable instance for `key` (created by `factory`, then overlaid with the stored fields). */
export function connect<T extends object>(key: string, factory: () => T): T {
  const existing = instances.get(key);
  if (existing !== undefined) {
    return existing as T;
  }
  const inst = factory();
  const stored = cache.get(key);
  if (stored !== undefined) {
    for (const k of Object.keys(stored)) {
      if (k in inst) {
        (inst as Record<string, unknown>)[k] = stored[k];
      }
    }
  }
  const p = proxy(inst);
  subscribe(p, () => {
    AsyncStorage.setItem(PREFIX + key, JSON.stringify(plainFields(p))).catch((e: unknown) => {
      Log.e('UNCAUGHT', `where=Persist.save key=${key} ${Log.errKv(e)}`);
    });
  });
  instances.set(key, p);
  return p;
}
