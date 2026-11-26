// Bildirim senaryoları (Edge Function'lar kullanır, Deno)
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { deriveFacts } from './game.ts';
import { generateVapid, type PushMessage, sendFcm, sendWebPush, type ServiceAccount, type Vapid } from './push.ts';
import type { MatchEvent } from './types.ts';

const SITE = 'https://langirt-lig.pages.dev';

export async function getVapid(svc: SupabaseClient): Promise<Vapid> {
  const read = async () => (await svc.from('app_secrets').select('value').eq('name', 'vapid').maybeSingle()).data?.value as Vapid | undefined;
  let v = await read();
  if (v) return v;
  // ilk kullanımda bir kez üretilir; aynı anda iki istek gelirse ilk yazılan kalır
  const fresh = await generateVapid(SITE);
  await svc.from('app_secrets').upsert({ name: 'vapid', value: fresh }, { onConflict: 'name', ignoreDuplicates: true });
  v = await read();
  return v ?? fresh;
}

function serviceAccount(): ServiceAccount | null {
  const raw = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.error('FIREBASE_SERVICE_ACCOUNT okunamadı');
    return null;
  }
}

/** Kullanıcı başına mesaj üretip o kullanıcının tüm cihazlarına gönderir; geçersiz kayıtları siler */
export async function sendToUsers(svc: SupabaseClient, msgFor: Map<string, PushMessage>): Promise<{ sent: number; failed: number }> {
  const ids = [...msgFor.keys()];
  if (!ids.length) return { sent: 0, failed: 0 };
  // Bildirimler sadece Android uygulamasına (FCM) gider. PUSH_KINDS sadece testlerde değiştirilir.
  const kinds = (Deno.env.get('PUSH_KINDS') ?? 'fcm').split(',');
  const { data: subs } = await svc.from('push_subscriptions').select('*').in('user_id', ids).in('kind', kinds);
  if (!subs?.length) return { sent: 0, failed: 0 };
  const sa = serviceAccount();
  const vapid = subs.some((s) => s.kind === 'web') ? await getVapid(svc) : null;
  let sent = 0, failed = 0;
  const gone: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      const msg = msgFor.get(s.user_id)!;
      let r: 'ok' | 'gone' | 'error' = 'error';
      if (s.kind === 'fcm' && sa) r = await sendFcm(sa, s.token, msg);
      if (s.kind === 'web' && vapid && s.keys) r = await sendWebPush(vapid, { endpoint: s.token, p256dh: s.keys.p256dh, auth: s.keys.auth }, msg);
      if (r === 'ok') sent++;
      else failed++;
      if (r === 'gone') gone.push(s.id);
    }),
  );
  if (gone.length) await svc.from('push_subscriptions').delete().in('id', gone);
  return { sent, failed };
}

const odds = (n: number | null | undefined) => (n == null ? '—' : Number(n).toFixed(2).replace('.', ','));
const coins = (n: number) => (Math.round(n * 100) / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });

async function names(svc: SupabaseClient): Promise<(id: string) => string> {
  const { data } = await svc.from('players').select('id,name');
  const m = new Map((data ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));
  return (id) => m.get(id) ?? '?';
}

/** Bahisler açıldı: maçta oynamayan tüm aktif kullanıcılara */
export async function notifyOpen(svc: SupabaseClient, matchId: string) {
  const { data: m } = await svc
    .from('matches')
    .update({ notified_open_at: new Date().toISOString() })
    .eq('id', matchId)
    .is('notified_open_at', null)
    .select('*')
    .maybeSingle();
  if (!m) return { sent: 0, failed: 0 }; // zaten gönderilmiş
  const nm = await names(svc);
  const { data: ms } = await svc.from('markets').select('id').eq('match_id', matchId).eq('code', 'ms').maybeSingle();
  const { data: sels } = ms ? await svc.from('selections').select('code, odds').eq('market_id', ms.id) : { data: [] as { code: string; odds: number | null }[] };
  const o = (c: string) => odds(sels?.find((s: any) => s.code === c)?.odds);
  const lineup = [m.a_f, m.a_k, m.b_f, m.b_k];
  const { data: users } = await svc.from('profiles').select('id, player_id').eq('status', 'active');
  const msg: PushMessage = {
    title: 'Bahisler açıldı',
    body: `${nm(m.a_f)} & ${nm(m.a_k)} – ${nm(m.b_f)} & ${nm(m.b_k)}\nMavi ${o('1')} · X ${o('X')} · Kırmızı ${o('2')}`,
    tab: 'match',
  };
  const to = new Map<string, PushMessage>();
  for (const u of users ?? []) if (!u.player_id || !lineup.includes(u.player_id)) to.set(u.id, msg);
  return sendToUsers(svc, to);
}

/** Maç sonuçlandı: herkese skor; kupon yapanlara sonuçları, oynayanlara ödülleri */
export async function notifySettled(svc: SupabaseClient, matchId: string) {
  const { data: m } = await svc
    .from('matches')
    .update({ notified_settled_at: new Date().toISOString() })
    .eq('id', matchId)
    .eq('status', 'approved')
    .is('notified_settled_at', null)
    .select('*')
    .maybeSingle();
  if (!m) return { sent: 0, failed: 0 };
  const nm = await names(svc);
  const [{ data: events }, { data: bets }, { data: rewards }, { data: users }] = await Promise.all([
    svc.from('match_events').select('*').eq('match_id', matchId),
    svc.from('bets').select('user_id, status, stake, payout').eq('match_id', matchId).neq('status', 'cancelled'),
    svc.from('transactions').select('user_id, amount').eq('match_id', matchId).eq('kind', 'reward'),
    svc.from('profiles').select('id').eq('status', 'active'),
  ]);
  const f = deriveFacts(((events ?? []) as MatchEvent[]).map((e) => ({ ...e, seq: Number(e.seq) })));
  const A = `${nm(m.a_f)} & ${nm(m.a_k)}`, B = `${nm(m.b_f)} & ${nm(m.b_k)}`;
  const result = f.goalsA > f.goalsB ? `${A} kazandı` : f.goalsB > f.goalsA ? `${B} kazandı` : `${A} ile ${B} berabere`;
  const title = `Maç bitti: Mavi ${f.goalsA}-${f.goalsB} Kırmızı`;
  const to = new Map<string, PushMessage>();
  for (const u of users ?? []) {
    const parts = [result];
    const mine = (bets ?? []).filter((b: any) => b.user_id === u.id);
    if (mine.length) {
      if (m.bets_voided) parts.push('Bu maçın kuponları iade edildi.');
      else {
        const settled = mine.filter((b: any) => b.status === 'won' || b.status === 'lost');
        const won = settled.filter((b: any) => b.status === 'won');
        const net = settled.reduce((s: number, b: any) => s + Number(b.payout) - Number(b.stake), 0);
        parts.push(`Kuponların: ${won.length}/${settled.length} tuttu, net ${net > 0 ? '+' : ''}${coins(net)} coin`);
      }
    }
    const rw = (rewards ?? []).filter((r: any) => r.user_id === u.id).reduce((s: number, r: any) => s + Number(r.amount), 0);
    if (rw > 0) parts.push(`Maç ödülü +${coins(rw)} coin`);
    to.set(u.id, { title, body: parts.join('\n'), tab: mine.length ? 'coupons' : 'match' });
  }
  return sendToUsers(svc, to);
}
