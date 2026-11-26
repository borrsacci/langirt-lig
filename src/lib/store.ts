import type { RealtimeChannel } from '@supabase/supabase-js';
import { create } from 'zustand';
import { rpc } from './api';
import { supabase } from './supabase';
import type { Bet, HistoryMatch, LeaderRow, Market, MatchEvent, MatchRow, Player, Profile, Selection } from './types';

type Part = 'access' | 'me' | 'profiles' | 'players' | 'current' | 'events' | 'markets' | 'matchBets' | 'myBets' | 'allBets' | 'queue' | 'history' | 'leaderboard';

interface State {
  booted: boolean;
  uid: string | null;
  me: Profile | null;
  profiles: Profile[];
  players: Player[];
  current: MatchRow | null;
  events: MatchEvent[];
  markets: (Market & { selections: Selection[] })[];
  matchBets: Bet[];
  myBets: Bet[];
  /** herkesin kuponları (maç başladıktan sonra görünür hale gelenler) */
  allBets: Bet[];
  queue: MatchRow[];
  history: HistoryMatch[];
  leaderboard: LeaderRow[];
  /** kura çekip maç açabilir mi (admin ayarına göre) */
  canCreate: boolean;
  /** sunucu saati − cihaz saati (ms) */
  offset: number;
  online: boolean;
  start: (uid: string | null) => Promise<void>;
  refresh: (...parts: Part[]) => Promise<void>;
  setCurrent: (m: MatchRow) => void;
  syncClock: () => Promise<void>;
}

const num = <T extends Record<string, any>>(o: T, keys: (keyof T)[]): T => {
  const c: any = { ...o };
  for (const k of keys) if (c[k] !== null && c[k] !== undefined) c[k] = Number(c[k]);
  return c;
};
const fixBet = (b: any): Bet => {
  const x = num(b, ['stake', 'odds', 'payout']);
  if (x.selection) x.selection = num(x.selection, ['odds', 'prob']);
  return x;
};

let channel: RealtimeChannel | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const pending = new Set<Part>();
let timer: ReturnType<typeof setTimeout> | null = null;

export const useStore = create<State>((set, get) => {
  const schedule = (...parts: Part[]) => {
    parts.forEach((p) => pending.add(p));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const ps = [...pending];
      pending.clear();
      get().refresh(...ps);
    }, 150);
  };

  const loaders: Record<Part, () => Promise<void>> = {
    access: async () => {
      const a = await rpc<{ can_create_match: boolean }>('my_access').catch(() => null);
      set({ canCreate: !!a?.can_create_match });
    },
    me: async () => {
      const uid = get().uid;
      if (!uid) return set({ me: null });
      const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
      set({ me: data ? num(data as Profile, ['balance']) : null });
    },
    profiles: async () => {
      const { data } = await supabase.from('profiles').select('*').order('display_name');
      if (data) set({ profiles: data.map((p) => num(p as Profile, ['balance'])) });
    },
    players: async () => {
      const { data } = await supabase.from('players').select('*').order('name');
      if (data) set({ players: data as Player[] });
    },
    current: async () => {
      const { data } = await supabase.from('matches').select('*').in('status', ['open', 'live', 'review']).order('created_at', { ascending: false }).limit(1);
      const cur = (data?.[0] as MatchRow) ?? null;
      const prev = get().current;
      set({ current: cur });
      if (cur?.id !== prev?.id) await Promise.all([loaders.events(), loaders.markets(), loaders.matchBets()]);
    },
    events: async () => {
      const cur = get().current;
      if (!cur) return set({ events: [] });
      const { data } = await supabase.from('match_events').select('*').eq('match_id', cur.id).order('seq');
      if (data && get().current?.id === cur.id) set({ events: data.map((e) => ({ ...e, seq: Number(e.seq) })) as MatchEvent[] });
    },
    markets: async () => {
      const cur = get().current;
      if (!cur) return set({ markets: [] });
      const { data } = await supabase.from('markets').select('*, selections(*)').eq('match_id', cur.id).order('sort');
      if (data && get().current?.id === cur.id)
        set({
          markets: data.map((m: any) => ({
            ...m,
            selections: (m.selections as Selection[]).map((s) => num(s, ['odds', 'prob'])).sort((a, b) => a.sort - b.sort),
          })),
        });
    },
    matchBets: async () => {
      const cur = get().current;
      if (!cur) return set({ matchBets: [] });
      const { data } = await supabase.from('bets').select('*').eq('match_id', cur.id).order('created_at', { ascending: false });
      if (data && get().current?.id === cur.id) set({ matchBets: data.map(fixBet) });
    },
    myBets: async () => {
      const uid = get().uid;
      if (!uid) return;
      const { data } = await supabase
        .from('bets')
        .select('*, selection:selections(*, market:markets(*)), match:matches(*)')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(300);
      if (data) set({ myBets: data.map(fixBet) });
    },
    allBets: async () => {
      const { data } = await supabase
        .from('bets')
        .select('*, selection:selections(*, market:markets(*)), match:matches(*)')
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(500);
      if (data) set({ allBets: data.map(fixBet) });
    },
    queue: async () => {
      const { data } = await supabase.from('matches').select('*').in('status', ['review', 'pending']).order('created_at');
      if (data) set({ queue: data as MatchRow[] });
    },
    history: async () => {
      const h = await rpc<HistoryMatch[]>('approved_history').catch(() => null);
      if (h) set({ history: h.map((m) => ({ ...m, events: m.events.map((e) => ({ ...e, seq: Number(e.seq) })) })) });
    },
    leaderboard: async () => {
      const l = await rpc<LeaderRow[]>('get_leaderboard').catch(() => null);
      if (l) set({ leaderboard: l.map((r) => num(r, ['balance', 'staked', 'returned', 'profit', 'biggest_win', 'best_odds'])) });
    },
  };

  return {
    booted: false,
    uid: null,
    me: null,
    profiles: [],
    players: [],
    current: null,
    events: [],
    markets: [],
    matchBets: [],
    myBets: [],
    allBets: [],
    queue: [],
    history: [],
    leaderboard: [],
    offset: 0,
    canCreate: false,
    online: true,

    async start(uid) {
      // Aynı anda gelen başlatma çağrılarında (oturum olayı + ilk yükleme) sadece sonuncusu geçerli
      const gen = ++generation;
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
      set({ uid, me: null, booted: false });
      if (!uid) return set({ booted: true });
      await loaders.me();
      if (gen !== generation) return;
      const me = get().me;
      if (me?.status === 'active') {
        await Promise.all([get().refresh('access', 'profiles', 'players', 'current', 'myBets', 'allBets', 'queue', 'history', 'leaderboard'), get().syncClock()]);
        if (gen !== generation) return;
        channel = supabase
          .channel(`db-${gen}-${Date.now()}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, (p: any) => {
            const st = p.new?.status;
            const parts: Part[] = ['current', 'queue', 'myBets'];
            if (st === 'approved' || st === 'rejected' || st === 'cancelled') parts.push('history', 'leaderboard', 'me', 'allBets');
            if (st === 'live') parts.push('allBets');
            if (p.new?.id && p.new.id === get().current?.id) {
              // canlı skor için gelen satırı beklemeden uygula
              if ((p.new.version ?? 0) >= (get().current?.version ?? 0)) set({ current: { ...get().current!, ...p.new } });
            }
            schedule(...parts);
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'match_events' }, () => schedule('events'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'bets' }, () => schedule('matchBets', 'myBets', 'allBets', 'leaderboard'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => schedule('me', 'access', 'profiles', 'leaderboard'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'players' }, () => schedule('players'))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'selections' }, () => schedule('markets', 'myBets'))
          .subscribe((status) => {
            const online = status === 'SUBSCRIBED';
            set({ online });
            // bağlantı koptuktan sonra geri gelince kaçırılan değişiklikleri çek
            if (online) schedule('me', 'current', 'events', 'markets', 'matchBets', 'myBets', 'queue');
          });
      }
      // Canlı bağlantı yoksa (zayıf mobil ağ vb.) maçı birkaç saniyede bir yokla
      if (me?.status === 'active')
        poll = setInterval(() => {
          if (!get().online && document.visibilityState === 'visible') get().refresh('current', 'events', 'matchBets', 'me');
        }, 4000);
      set({ booted: true });
    },

    async refresh(...parts) {
      if (!get().uid) return;
      const list = parts.length ? parts : (Object.keys(loaders) as Part[]);
      const order: Part[] = ['me', 'current'];
      // önce maç (diğerleri ona bağlı), sonra geri kalanı paralel
      for (const p of order) if (list.includes(p)) await loaders[p]().catch(() => {});
      await Promise.all(list.filter((p) => !order.includes(p)).map((p) => loaders[p]().catch(() => {})));
    },

    setCurrent(m) {
      const cur = get().current;
      if (!cur || cur.id !== m.id || m.version >= cur.version) {
        if (['open', 'live', 'review'].includes(m.status)) set({ current: m });
        else schedule('current');
      }
    },

    async syncClock() {
      const t0 = Date.now();
      const s = await rpc<string>('server_now').catch(() => null);
      const t1 = Date.now();
      if (s) set({ offset: Math.round(Date.parse(s) - (t0 + t1) / 2) });
    },
  };
});

export const playerName = (id: string | null | undefined) =>
  (id && useStore.getState().players.find((p) => p.id === id)?.name) || '?';

export function usePlayerName() {
  const players = useStore((s) => s.players);
  return (id: string | null | undefined) => (id && players.find((p) => p.id === id)?.name) || '?';
}
