// Bildirim aboneliği: Android uygulamasında Firebase (FCM), tarayıcıda/iPhone'da Web Push
import { PushNotifications } from '@capacitor/push-notifications';
import { invoke, rpc } from './api';
import { isNative } from './native';
import { useNav, type Tab } from './nav';

const TOKEN_KEY = 'langirt-push-token';
const fcmEnabled = import.meta.env.VITE_FCM === '1';

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'ios-install';

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;

function store(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* önemsiz */
  }
}
function stored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function pushState(): Promise<PushState> {
  if (isNative) {
    if (!fcmEnabled) return 'unsupported';
    const p = await PushNotifications.checkPermissions();
    if (p.receive === 'denied') return 'denied';
    return p.receive === 'granted' && stored() ? 'on' : 'off';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return Notification.permission === 'granted' && sub ? 'on' : 'off';
}

let listenersReady = false;
async function nativeListeners() {
  if (listenersReady) return;
  listenersReady = true;
  await PushNotifications.addListener('registration', async (t) => {
    store(t.value);
    await rpc('register_push', { p_kind: 'fcm', p_token: t.value, p_keys: null }).catch(() => {});
  });
  await PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const tab = (a.notification.data?.tab as Tab) || 'match';
    useNav.getState().go(tab);
  });
}

async function registerWeb(): Promise<void> {
  const reg = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await invoke<{ publicKey: string }>('notify', { action: 'vapid' });
  let sub = await reg.pushManager.getSubscription();
  const keyMatches = sub && arrEq(new Uint8Array(sub.options.applicationServerKey ?? new ArrayBuffer(0)), urlB64(publicKey));
  if (sub && !keyMatches) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(publicKey) as BufferSource });
  const j = sub.toJSON();
  store(sub.endpoint);
  await rpc('register_push', { p_kind: 'web', p_token: sub.endpoint, p_keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } });
}

/** Kullanıcı "Bildirimleri aç"a basınca (izin isteği bir dokunuşla tetiklenmeli) */
export async function enablePush(): Promise<PushState> {
  if (isNative) {
    if (!fcmEnabled) return 'unsupported';
    await nativeListeners();
    let p = await PushNotifications.checkPermissions();
    if (p.receive !== 'granted') p = await PushNotifications.requestPermissions();
    if (p.receive !== 'granted') return 'denied';
    await PushNotifications.createChannel({ id: 'mac', name: 'Maçlar ve bahisler', importance: 5, visibility: 1, vibration: true }).catch(() => {});
    await PushNotifications.register();
    // kayıt anahtarı 'registration' olayıyla gelir
    for (let i = 0; i < 20 && !stored(); i++) await new Promise((r) => setTimeout(r, 250));
    return stored() ? 'on' : 'off';
  }
  const st = await pushState();
  if (st === 'unsupported' || st === 'ios-install') return st;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  await registerWeb();
  return 'on';
}

/** Uygulama açılışında: izin önceden verildiyse kaydı tazeler (anahtarlar değişebilir) */
export async function initPush() {
  try {
    if (!isNative && 'serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'open-tab') useNav.getState().go(e.data.tab as Tab);
      });
    }
    if (isNative) {
      if (!fcmEnabled) return;
      await nativeListeners();
      const p = await PushNotifications.checkPermissions();
      if (p.receive === 'granted') await PushNotifications.register();
      return;
    }
    if ('Notification' in window && Notification.permission === 'granted' && 'PushManager' in window) await registerWeb();
  } catch {
    /* bildirim olmadan da uygulama çalışır */
  }
}

/** Çıkış yaparken bu cihaz artık o hesap adına bildirim almasın */
export async function unregisterThisDevice() {
  const t = stored();
  if (!t) return;
  await rpc('unregister_push', { p_token: t }).catch(() => {});
  store(null);
}

export async function sendTestPush() {
  return invoke<{ sent: number; failed: number }>('notify', { action: 'test' });
}

function urlB64(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}
function arrEq(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
