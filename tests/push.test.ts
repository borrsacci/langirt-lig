// Web Push şifrelemesi (RFC 8291) ve VAPID imzası (RFC 8292) doğrulaması:
// tarayıcının (alıcının) yapacağı çözme işlemini burada bağımsız olarak uyguluyoruz.
import { describe, expect, it } from 'vitest';
import { b64url, encryptWebPush, generateVapid, sendWebPush, unb64url, vapidJwt } from '../supabase/functions/_shared/push.ts';

const enc = new TextEncoder();
async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p: Uint8Array[]) => {
  const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) { o.set(x, i); i += x.length; }
  return o;
};

/** Alıcı tarafı: RFC 8291'e göre çöz */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  expect(pt[pt.length - 1]).toBe(2); // son kayıt ayıracı
  return new TextDecoder().decode(pt.slice(0, -1));
}

describe('web push', () => {
  it('şifrelenen bildirim alıcı tarafından çözülür', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const p256dh = b64url(await crypto.subtle.exportKey('raw', ua.publicKey));
    const msg = JSON.stringify({ title: 'Bahisler açıldı', body: 'Okan & Caner – Burak & Tolga · 1: 1,85' });
    const body = await encryptWebPush(enc.encode(msg), p256dh, b64url(auth));
    expect(body.length).toBeLessThan(4096);
    expect(await decrypt(body, ua, auth)).toBe(msg);
  });

  it('VAPID imzası açık anahtarla doğrulanır', async () => {
    const v = await generateVapid('https://langirt-lig.pages.dev');
    expect(unb64url(v.publicKey).length).toBe(65);
    const jwt = await vapidJwt(v, 'https://web.push.apple.com', 1_800_000_000);
    const [h, c, s] = jwt.split('.');
    const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
    expect(claims).toMatchObject({ aud: 'https://web.push.apple.com', sub: 'https://langirt-lig.pages.dev' });
    const pub = await crypto.subtle.importKey('raw', unb64url(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64url(s), enc.encode(`${h}.${c}`))).toBe(true);
  });

  it('gönderim isteği doğru başlıklarla yapılır, silinmiş abonelik tanınır', async () => {
    const v = await generateVapid('https://x.test');
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: 'https://push.example.com/abc', p256dh: b64url(await crypto.subtle.exportKey('raw', ua.publicKey)), auth: b64url(auth) };
    let seen: RequestInit | undefined;
    const ok = await sendWebPush(v, sub, { title: 't', body: 'b' }, (async (_u: any, init: any) => {
      seen = init;
      return new Response(null, { status: 201 });
    }) as any);
    expect(ok).toBe('ok');
    const hdr = seen!.headers as Record<string, string>;
    expect(hdr['Content-Encoding']).toBe('aes128gcm');
    expect(hdr.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(await decrypt(new Uint8Array(seen!.body as ArrayBuffer), ua, auth))).toEqual({ title: 't', body: 'b' });
    const gone = await sendWebPush(v, sub, { title: 't', body: 'b' }, (async () => new Response(null, { status: 410 })) as any);
    expect(gone).toBe('gone');
  });
});
