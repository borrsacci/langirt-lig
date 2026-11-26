// Kadro kesinleşince çağrılır: tüm onaylı maç geçmişinden modeli kurar, oranları
// hesaplar ve maçı oranlarıyla birlikte tek işlemde (atomik) açar.
// Oranlar sadece burada, sunucuda hesaplanır; uygulama oran gönderemez.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, HttpError, isUuid, json } from '../_shared/http.ts';
import { fitForLineup, roleImpact, type MatchRecord } from '../_shared/model.ts';
import { notifyOpen } from '../_shared/notify.ts';
import { priceMatch } from '../_shared/pricing.ts';
import type { Lineup } from '../_shared/types.ts';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'Sadece POST');
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: u, error: ue } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (ue || !u.user) throw new HttpError(401, 'Oturum geçersiz, tekrar giriş yapın');

    const body = await req.json().catch(() => ({}));
    const l = body?.lineup as Lineup | undefined;
    if (!l || ![l.AF, l.AK, l.BF, l.BK].every(isUuid) || new Set([l.AF, l.AK, l.BF, l.BK]).size !== 4) {
      throw new HttpError(400, 'Geçersiz kadro');
    }

    const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
    const [{ data: players, error: pe }, { data: history, error: he }] = await Promise.all([
      svc.from('players').select('id,name'),
      svc.rpc('approved_history'),
    ]);
    if (pe || he) throw new Error(pe?.message ?? he?.message);
    const names = new Map((players ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));

    const records = (history ?? []).map((m: any) => ({ match: m, events: m.events })) as MatchRecord[];
    const model = fitForLineup(records, l);
    const pricing = priceMatch(model, l, (id) => names.get(id) ?? '?');

    const ratings = Object.fromEntries([l.AF, l.AK, l.BF, l.BK].map((id) => [id, roleImpact(model, id)]));
    const snapshot = {
      probs: pricing.probs,
      expectedGoals: pricing.expectedGoals,
      rates: pricing.rates,
      nMatches: model.nMatches,
      effMatches: model.effMatches,
      ratings,
      pair: {
        A: model.pairs[[l.AF, l.AK].sort().join('|')] ?? 0,
        B: model.pairs[[l.BF, l.BK].sort().join('|')] ?? 0,
      },
      version: 1,
    };
    const { data: matchId, error: ce } = await svc.rpc('svc_create_match', {
      p_created_by: u.user.id,
      p_lineup: l,
      p_markets: pricing.markets,
      p_model: snapshot,
    });
    if (ce) throw new HttpError(400, ce.message);
    // Bildirim hatası maçın açılmasını engellemesin
    const notified = await notifyOpen(svc, matchId as string).catch((e) => {
      console.error('bildirim', e);
      return null;
    });
    return json({ match_id: matchId, notified });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
