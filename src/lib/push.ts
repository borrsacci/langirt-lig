// Bildirim aboneliği: sadece Android uygulamasında, Firebase (FCM) ile
import { PushNotifications } from '@capacitor/push-notifications';
import { invoke, rpc } from './api';
import { isNative } from './native';
import { useNav, type Tab } from './nav';

const TOKEN_KEY = 'langirt-push-token';
const fcmEnabled = import.meta.env.VITE_FCM === '1';

export type PushState = 'on' | 'off' | 'denied' | 'unsupported' | 'ios-install';


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
  // Bildirimler sadece Android uygulamasında (web/iPhone sürümünde yok)
  return 'unsupported';
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
  return 'unsupported';
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
    // web sürümünde önceden açılmış abonelik varsa kapat
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await rpc('unregister_push', { p_token: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
      store(null);
    }
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
