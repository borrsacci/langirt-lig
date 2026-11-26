// Uçtan uca bildirim testi: sahte bir web push servisi kurar, gerçek Edge Function'lar
// (create-match, notify) üzerinden gelen bildirimleri telefon gibi çözüp içeriğini kontrol eder.
import { webcrypto as crypto } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';

const API = 'http://127.0.0.1:54321';
const ANON = process.env.ANON;
const db = new pg.Client({ host: '/tmp', port: 55432, user: 'postgres', database: 'e2e' });
await db.connect();
const enc = new TextEncoder();
const b64 = (u) => Buffer.from(u).toString('base64url');
const errors = [];
const check = (c, m) => { if (!c) errors.push(m); };

// ---- sahte push servisi
const inbox = {}; // abonelik adı → çözülmüş mesajlar
const subs = {};
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const name = req.url.slice(1);
    if (name === 'expired') { res.writeHead(410); return res.end(); }
    try {
      check(/^vapid t=.+, k=.+/.test(req.headers.authorization ?? ''), 'VAPID başlığı yok');
      check(req.headers['content-encoding'] === 'aes128gcm', 'şifreleme başlığı yok');
      (inbox[name] ??= []).push(JSON.parse(await decrypt(new Uint8Array(Buffer.concat(chunks)), subs[name])));
      res.writeHead(201);
    } catch (e) {
      errors.push('çözme hatası: ' + e.message);
      res.writeHead(400);
    }
    res.end();
  });
});
await new Promise((r) => server.listen(54500, '127.0.0.1', r));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
async function decrypt(body, s) {
  const salt = body.slice(0, 16), idlen = body[20], asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, s.keys.privateKey, 256));
  const ikm = await hmac(await hmac(s.auth, ecdh), cat(enc.encode('WebPush: info\0'), s.pub, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), [1]))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  return new TextDecoder().decode(pt.slice(0, -1));
}

// ---- API yardımcıları
async function call(path, token, body, method = 'POST') {
  const r = await fetch(API + path, { method, headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  const j = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error(`${path}: ${j?.message ?? j?.error ?? j?.msg ?? t}`);
  return j;
}
const rpc = (tok, fn, args = {}) => call(`/rest/v1/rpc/${fn}`, tok, args);
async function signup(u) {
  const j = await call('/auth/v1/signup', null, { email: `${u}@users.langirt.app`, password: 'sifre123', data: { username: u, display_name: u[0].toUpperCase() + u.slice(1) } });
  return { tok: j.access_token, id: j.user.id };
}
async function subscribe(user, name) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  subs[name] = { keys, pub, auth };
  // Gerçekte bildirimler sadece Android'e (FCM) gider; mesaj içeriklerini yerelde doğrulayabilmek için
  // test aboneliği doğrudan eklenir ve fonksiyonlar PUSH_KINDS=fcm,web ile çalıştırılır.
  await db.query(`insert into push_subscriptions (user_id, kind, token, keys) values ($1, 'web', $2, $3)`, [user.id, `http://127.0.0.1:54500/${name}`, { p256dh: b64(pub), auth: b64(auth) }]);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const admin = await signup('okan');
  const U = {};
  for (const u of ['caner', 'burak', 'tolga', 'sefa']) {
    U[u] = await signup(u);
    await rpc(admin.tok, 'admin_approve_user', { p_user: U[u].id, p_player: null });
  }
  const pid = Object.fromEntries((await db.query('select id, name from players')).rows.map((r) => [r.name, r.id]));

  // VAPID anahtarı tek ve kalıcı
  const v1 = await call('/functions/v1/notify', null, { action: 'vapid' });
  const v2 = await call('/functions/v1/notify', null, { action: 'vapid' });
  check(v1.publicKey && v1.publicKey === v2.publicKey, 'VAPID anahtarı değişti');
  check((await db.query(`select count(*)::int c from app_secrets`)).rows[0].c === 1, 'app_secrets tek kayıt değil');

  // web/iPhone aboneliği kabul edilmez (bildirim sadece Android)
  let webRejected = false;
  try { await rpc(U.sefa.tok, 'register_push', { p_kind: 'web', p_token: 'https://x.test/1', p_keys: { p256dh: 'a', auth: 'b' } }); } catch { webRejected = true; }
  check(webRejected, 'web aboneliği kabul edildi');
  await rpc(U.sefa.tok, 'register_push', { p_kind: 'fcm', p_token: 'fcm-test-token', p_keys: null });
  check((await db.query(`select count(*)::int c from push_subscriptions where token='fcm-test-token'`)).rows[0].c === 1, 'Android kaydı eklenmedi');
  await db.query(`delete from push_subscriptions where token='fcm-test-token'`);
  // abonelikler: Sefa (izleyici), Okan (oyuncu), Sefa'nın eski telefonu (süresi dolmuş)
  await subscribe(U.sefa, 'sefa');
  await subscribe(admin, 'okan');
  await subscribe(U.sefa, 'expired');
  // kullanıcılar abonelik tablosunu okuyamaz
  let leaked = true;
  try { await call('/rest/v1/push_subscriptions?select=*', U.sefa.tok, null, 'GET'); } catch { leaked = false; }
  check(!leaked, 'abonelik tablosu kullanıcılara açık');

  // deneme bildirimi
  await call('/functions/v1/notify', U.sefa.tok, { action: 'test' });

  // bahisler açılır → sadece maçta oynamayana gider
  const lineup = { AF: pid.Okan, AK: pid.Caner, BF: pid.Burak, BK: pid.Tolga };
  const cm = await call('/functions/v1/create-match', U.caner.tok, { lineup });
  await wait(300);
  const open = inbox.sefa?.find((m) => m.title === 'Bahisler açıldı');
  check(open && /Okan & Caner – Burak & Tolga/.test(open.body) && /Mavi \d+,\d\d · X/.test(open.body), 'bahis açıldı bildirimi yok/yanlış: ' + JSON.stringify(inbox.sefa));
  check(!(inbox.okan ?? []).some((m) => m.title === 'Bahisler açıldı'), 'maçtaki oyuncuya bahis bildirimi gitti');
  check((await db.query(`select count(*)::int c from push_subscriptions where token like '%expired'`)).rows[0].c === 0, 'süresi dolan abonelik silinmedi');

  // Sefa kupon yapar, maç oynanır, onaylanır
  const sel = (await db.query(`select s.id from selections s join markets m on m.id=s.market_id where s.match_id=$1 and m.code='ms' and s.code='1'`, [cm.match_id])).rows[0].id;
  await rpc(U.sefa.tok, 'place_bet', { p_selection: sel, p_stake: 50 });
  await rpc(U.caner.tok, 'start_match', { p_match: cm.match_id });
  for (const p of [pid.Okan, pid.Okan, pid.Burak]) await rpc(U.caner.tok, 'record_goal', { p_match: cm.match_id, p_event: crypto.randomUUID(), p_player: p, p_client_remaining_ms: null });
  await rpc(U.caner.tok, 'finish_early', { p_match: cm.match_id });
  await rpc(U.caner.tok, 'submit_match', { p_match: cm.match_id });
  // admin olmayan sonuç bildirimi tetikleyemez
  let blocked = false;
  try { await call('/functions/v1/notify', U.sefa.tok, { action: 'settled', match_id: cm.match_id }); } catch { blocked = true; }
  check(blocked, 'admin olmayan sonuç bildirimi gönderebildi');
  // onaydan önce sonuç bildirimi gitmez
  await call('/functions/v1/notify', admin.tok, { action: 'settled', match_id: cm.match_id });
  check(!(inbox.sefa ?? []).some((m) => m.title.startsWith('Maç bitti')), 'onaysız maç için sonuç bildirimi gitti');
  await rpc(admin.tok, 'approve_match', { p_match: cm.match_id, p_void_bets: false, p_note: null });
  await call('/functions/v1/notify', admin.tok, { action: 'settled', match_id: cm.match_id });
  await call('/functions/v1/notify', admin.tok, { action: 'settled', match_id: cm.match_id }); // ikinci kez: gitmemeli
  await wait(300);
  const sefaEnd = (inbox.sefa ?? []).filter((m) => m.title.startsWith('Maç bitti'));
  const okanEnd = (inbox.okan ?? []).filter((m) => m.title.startsWith('Maç bitti'));
  check(sefaEnd.length === 1 && okanEnd.length === 1, `sonuç bildirimi sayısı yanlış: ${sefaEnd.length}/${okanEnd.length}`);
  check(sefaEnd[0]?.title === 'Maç bitti: Mavi 2-1 Kırmızı', 'başlık yanlış: ' + sefaEnd[0]?.title);
  check(/Okan & Caner kazandı/.test(sefaEnd[0]?.body) && /Kuponların: 1\/1 tuttu, net \+\d/.test(sefaEnd[0]?.body), 'izleyici sonucu yanlış: ' + sefaEnd[0]?.body);
  check(/Maç ödülü \+30 coin/.test(okanEnd[0]?.body), 'oyuncu ödülü yok: ' + okanEnd[0]?.body);
  console.log('İzleyiciye gelenler:', JSON.stringify(inbox.sefa, null, 1));
  console.log('Oyuncuya gelenler:', JSON.stringify(inbox.okan, null, 1));
} catch (e) {
  errors.push('TEST HATASI: ' + e.message);
} finally {
  console.log(errors.length ? 'HATALAR:\n' + errors.join('\n') : 'HATA YOK');
  server.close();
  await db.end();
}
