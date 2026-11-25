// Onaylı maçlardan istatistikler. Hepsi olay kaydından türetilir (paylaşılan game.ts).
import { deriveFacts, goalsOf, roleTimes, winnerOf } from '../../supabase/functions/_shared/game.ts';
import { fitModel, type ModelParams } from '../../supabase/functions/_shared/model.ts';
import { HALF_MS, pairKey } from '../../supabase/functions/_shared/types.ts';
import type { HistoryMatch } from './types';

export interface PlayerStat {
  id: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goals: number;
  goalsF: number;
  goalsK: number;
  conceded: number; // kaleciyken yenilen
  msF: number;
  msK: number;
  scoredAgainst: Record<string, number>; // kaleci → gol
  concededFrom: Record<string, number>; // golcü → gol
  form: ('G' | 'B' | 'M')[]; // son 5 maç, en yeni sonda
  streak: number; // en uzun galibiyet serisi
}

export interface PairStat {
  key: string;
  a: string;
  b: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  gf: number;
  ga: number;
}

export interface Stats {
  players: Record<string, PlayerStat>;
  pairs: PairStat[];
  totalMatches: number;
  totalGoals: number;
  biggestWin: { match: HistoryMatch; diff: number; a: number; b: number } | null;
}

const blank = (id: string): PlayerStat => ({
  id, played: 0, won: 0, drawn: 0, lost: 0, goals: 0, goalsF: 0, goalsK: 0, conceded: 0, msF: 0, msK: 0,
  scoredAgainst: {}, concededFrom: {}, form: [], streak: 0,
});

export function computeStats(history: HistoryMatch[]): Stats {
  const players: Record<string, PlayerStat> = {};
  const pairs = new Map<string, PairStat>();
  const cur: Record<string, number> = {};
  let totalGoals = 0;
  let biggestWin: Stats['biggestWin'] = null;
  const sorted = [...history].sort((x, y) => x.created_at.localeCompare(y.created_at));

  for (const m of sorted) {
    const f = deriveFacts(m.events);
    const w = winnerOf(f);
    totalGoals += f.goalsA + f.goalsB;
    const diff = Math.abs(f.goalsA - f.goalsB);
    if (diff > 0 && (!biggestWin || diff > biggestWin.diff)) biggestWin = { match: m, diff, a: f.goalsA, b: f.goalsB };
    const rt = roleTimes(m, m.events);
    const teams = { A: [m.a_f, m.a_k], B: [m.b_f, m.b_k] } as const;
    for (const t of ['A', 'B'] as const) {
      const res: 'G' | 'B' | 'M' = w === 'D' ? 'B' : w === t ? 'G' : 'M';
      for (const id of teams[t]) {
        const s = (players[id] ??= blank(id));
        s.played++;
        if (res === 'G') s.won++;
        else if (res === 'M') s.lost++;
        else s.drawn++;
        s.form.push(res);
        if (s.form.length > 5) s.form.shift();
        cur[id] = res === 'G' ? (cur[id] ?? 0) + 1 : 0;
        s.streak = Math.max(s.streak, cur[id]);
        s.msF += rt[id]?.F ?? 0;
        s.msK += rt[id]?.K ?? 0;
      }
      const [a, b] = teams[t];
      const k = pairKey(a, b);
      const p = pairs.get(k) ?? { key: k, a: a < b ? a : b, b: a < b ? b : a, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0 };
      p.played++;
      if (res === 'G') p.won++;
      else if (res === 'M') p.lost++;
      else p.drawn++;
      p.gf += t === 'A' ? f.goalsA : f.goalsB;
      p.ga += t === 'A' ? f.goalsB : f.goalsA;
      pairs.set(k, p);
    }
    for (const g of goalsOf(m.events)) {
      const s = (players[g.player_id!] ??= blank(g.player_id!));
      s.goals++;
      if (g.role === 'K') s.goalsK++;
      else s.goalsF++;
      if (g.keeper_id) {
        s.scoredAgainst[g.keeper_id] = (s.scoredAgainst[g.keeper_id] ?? 0) + 1;
        const k = (players[g.keeper_id] ??= blank(g.keeper_id));
        k.conceded++;
        k.concededFrom[g.player_id!] = (k.concededFrom[g.player_id!] ?? 0) + 1;
      }
    }
  }
  return { players, pairs: [...pairs.values()], totalMatches: sorted.length, totalGoals, biggestWin };
}

/** Kaleciyken 3 dakikada (bir yarı) yenilen gol */
export const concededPerHalf = (s: PlayerStat) => (s.msK > 0 ? (s.conceded / s.msK) * HALF_MS : null);
/** Forvetken 3 dakikada atılan gol */
export const goalsPerHalfF = (s: PlayerStat) => (s.msF > 0 ? (s.goalsF / s.msF) * HALF_MS : null);
export const winRate = (s: { played: number; won: number }) => (s.played ? s.won / s.played : 0);

export function topOf(rec: Record<string, number>): [string, number] | null {
  const e = Object.entries(rec).sort((a, b) => b[1] - a[1])[0];
  return e && e[1] > 0 ? e : null;
}

/** Kura için: hangi ikili kaç kez birlikte oynadı */
export function pairCounts(history: HistoryMatch[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const m of history) {
    for (const [a, b] of [[m.a_f, m.a_k], [m.b_f, m.b_k]]) {
      const k = pairKey(a, b);
      c[k] = (c[k] ?? 0) + 1;
    }
  }
  return c;
}

/** Oranları hesaplayan modelin aynısı (ekrandaki güç puanları için; belirsizlik örneği olmadan) */
export function modelOf(history: HistoryMatch[]): ModelParams {
  return fitModel(history.map((m) => ({ match: m, events: m.events })));
}
