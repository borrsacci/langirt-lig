// Bildirim gönderme: Android (Firebase Cloud Messaging HTTP v1) ve web/iPhone (Web Push,
// RFC 8291 aes128gcm şifreleme + RFC 8292 VAPID). Sadece WebCrypto ve fetch kullanır;
// hem Deno (Edge Function) hem Node (testler) üzerinde çalışır.

const enc = new TextEncoder();
/** Uint8Array'in kendi kopyası olan ArrayBuffer (WebCrypto ve fetch tipleriyle uyumlu) */
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(s: string): Uint8Array {
  const p = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ab(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, ab(data)));
}

export interface PushMessage {
  title: string;
  body: string;
  /** uygulamada hangi sekme açılsın */
  tab?: 'match' | 'coupons';
}

export type SendResult = 'ok' | 'gone' | 'error';

// ---------------------------------------------------------------- Web Push

export interface Vapid {
  publicKey: string; // base64url, 65 bayt sıkıştırılmamış P-256 noktası
  privateJwk: JsonWebKey;
  subject: string;
}

export async function generateVapid(subject: string): Promise<Vapid> {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { publicKey: b64url(raw), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey), subject };
}

export async function vapidJwt(v: Vapid, audience: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: audience, exp: nowSec + 12 * 3600, sub: v.subject })));
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto ECDSA imzası zaten JWS'in istediği r||s (64 bayt) biçiminde
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

/** RFC 8291: yükü alıcının anahtarlarıyla şifreler (tek kayıt, aes128gcm) */
export async function encryptWebPush(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
  opts: { salt?: Uint8Array; asKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = unb64url(p256dh);
  const authSecret = unb64url(auth);
  const as = opts.asKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ab(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, ecdh);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', ab(cek), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(nonce) }, key, ab(concat(payload, new Uint8Array([2])))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

export async function sendWebPush(
  v: Vapid,
  sub: { endpoint: string; p256dh: string; auth: string },
  msg: PushMessage,
  fetchFn: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const body = await encryptWebPush(enc.encode(JSON.stringify(msg)), sub.p256dh, sub.auth);
    const jwt = await vapidJwt(v, new URL(sub.endpoint).origin);
    const r = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '43200',
        Urgency: 'high',
        Authorization: `vapid t=${jwt}, k=${v.publicKey}`,
      },
      body: ab(body),
    });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

// ---------------------------------------------------------------- FCM (Android)

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let fcmToken: { token: string; exp: number } | null = null;

async function fcmAccessToken(sa: ServiceAccount, fetchFn: typeof fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.exp > now + 60) return fcmToken.token;
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(
    enc.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', ab(der), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${claims}.${b64url(sig)}`,
  });
  if (!r.ok) throw new Error(`Google token alınamadı: ${r.status} ${await r.text()}`);
  const j = await r.json();
  fcmToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return fcmToken.token;
}

export async function sendFcm(sa: ServiceAccount, token: string, msg: PushMessage, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  try {
    const access = await fcmAccessToken(sa, fetchFn);
    const r = await fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: { tab: msg.tab ?? 'match' },
          android: {
            priority: 'HIGH',
            notification: { channel_id: 'mac', icon: 'ic_stat_notify', color: '#F2C14E', sound: 'default' },
          },
        },
      }),
    });
    if (r.status === 404) return 'gone';
    if (!r.ok) {
      const t = await r.text();
      if (/UNREGISTERED|registration-token-not-registered/.test(t)) return "gone";
      console.error('FCM', r.status, t);
      return 'error';
    }
    return 'ok';
  } catch (e) {
    console.error('FCM', e);
    return 'error';
  }
}
