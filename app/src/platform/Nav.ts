/*
 * The ArkUI NavPathStack/NavPathInfo that AppViewModel drives, mapped onto expo-router: every Routes.X name is a
 * route file src/app/<name>.tsx and the one parameter travels as the `p` search param. The stack itself is the
 * native navigation stack (react-native-screens), so the system back gesture works as on iOS.
 */
import { router } from 'expo-router';
import { Log } from '../app/Log';

export class NavPathInfo {
  name: string;
  param: string;

  constructor(name: string, param: unknown) {
    this.name = name;
    this.param = param === undefined || param === null ? '' : String(param);
  }
}

export class NavPathStack {
  private depth: number = 0;

  pushPath(info: NavPathInfo): void {
    try {
      router.push({ pathname: `/${info.name}` as never, params: { p: info.param } });
      this.depth++;
    } catch (e) {
      Log.e('UNCAUGHT', `where=Nav.push name=${info.name} ${Log.errKv(e)}`);
    }
  }

  replacePath(info: NavPathInfo): void {
    try {
      router.replace({ pathname: `/${info.name}` as never, params: { p: info.param } });
    } catch (e) {
      Log.e('UNCAUGHT', `where=Nav.replace name=${info.name} ${Log.errKv(e)}`);
    }
  }

  pop(): void {
    try {
      if (router.canGoBack()) {
        router.back();
      }
      this.depth = Math.max(0, this.depth - 1);
    } catch (e) {
      Log.e('UNCAUGHT', `where=Nav.pop ${Log.errKv(e)}`);
    }
  }

  /** Back to the root screen (Home or Onboarding). The animated flag is accepted for parity and ignored. */
  clear(_animated: boolean = true): void {
    try {
      if (router.canDismiss()) {
        router.dismissAll();
      }
      this.depth = 0;
    } catch (e) {
      Log.e('UNCAUGHT', `where=Nav.clear ${Log.errKv(e)}`);
    }
  }

  size(): number {
    return this.depth;
  }
}
