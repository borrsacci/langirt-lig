// Maç olay kaydından (event log) tüm sonuçların türetilmesi.
// Skor, devre skoru, oyuncu golleri, mevki süreleri ve model için "segment"ler
// tek bir yerden hesaplanır; böylece ekran, istatistik, bahis ve oran motoru
// asla birbirinden farklı sonuç göremez.

import {
  HALF_MS,
  type Lineup,
  type MatchCore,
  type MatchEvent,
  type MatchFacts,
  type Role,
  type Slot,
  type Team,
  initialLineup,
  slotOf,
  swapTeamRoles,
} from './types.ts';

export function liveEvents(events: MatchEvent[]): MatchEvent[] {
  return events.filter((e) => !e.deleted_at).sort((x, y) => x.seq - y.seq);
}

export function goalsOf(events: MatchEvent[]): MatchEvent[] {
  return liveEvents(events).filter((e) => e.kind === 'goal');
}

/** Bahis sonuçlandırma ve skor tablosu için gerekli olgular */
export function deriveFacts(events: MatchEvent[]): MatchFacts {
  const goals = goalsOf(events);
  const f: MatchFacts = { goalsA: 0, goalsB: 0, htA: 0, htB: 0, playerGoals: {}, firstScorer: null };
  for (const g of goals) {
    if (g.team === 'A') f.goalsA++;
    else f.goalsB++;
    if (g.half === 1) {
      if (g.team === 'A') f.htA++;
      else f.htB++;
    }
    if (g.player_id) f.playerGoals[g.player_id] = (f.playerGoals[g.player_id] ?? 0) + 1;
  }
  const first = [...goals].sort((x, y) => x.half - y.half || x.seq - y.seq)[0];
  f.firstScorer = first?.player_id ?? null;
  return f;
}

/** Belirli bir andaki (yarı + o yarıdaki olay sırası) kadro */
export function lineupAfter(m: Pick<MatchCore, 'a_f' | 'a_k' | 'b_f' | 'b_k'>, events: MatchEvent[], uptoSeq = Infinity): Lineup {
  let l = initialLineup(m);
  for (const e of liveEvents(events)) {
    if (e.seq > uptoSeq) break;
    if (e.kind === 'swap') l = swapTeamRoles(l, e.team);
  }
  return l;
}

export function hasSwapped(events: MatchEvent[], team: Team): boolean {
  return liveEvents(events).some((e) => e.kind === 'swap' && e.team === team);
}

/** Bir zaman aralığı boyunca sabit kadroyla oynanan bölüm */
export interface Segment {
  lineup: Lineup;
  ms: number;
  goals: Record<Slot, number>; // süre işlerken atılan goller
}

/** Süre bittikten sonra son topta atılan gol: "kim önce atar" yarışı */
export interface RaceGoal {
  lineup: Lineup;
  scorer: Slot;
}

export interface MatchSegments {
  segments: Segment[];
  races: RaceGoal[];
}

function playedMs(m: Pick<MatchCore, 'half1_ms' | 'half2_ms'>, half: 1 | 2): number {
  const v = half === 1 ? m.half1_ms : m.half2_ms;
  return Math.max(0, Math.min(HALF_MS, v ?? 0));
}

export function segmentsOf(m: MatchCore, events: MatchEvent[]): MatchSegments {
  const evs = liveEvents(events);
  const out: MatchSegments = { segments: [], races: [] };
  let lineup = initialLineup(m);
  for (const half of [1, 2] as const) {
    const total = playedMs(m, half);
    let start = 0;
    let cur: Segment = { lineup, ms: 0, goals: { AF: 0, AK: 0, BF: 0, BK: 0 } };
    const close = (end: number) => {
      cur.ms = Math.max(0, Math.min(total, end) - start);
      if (cur.ms > 0 || Object.values(cur.goals).some((n) => n > 0)) out.segments.push(cur);
      start = Math.max(start, Math.min(total, end));
    };
    for (const e of evs.filter((x) => x.half === half)) {
      if (e.kind === 'swap') {
        close(e.clock_ms);
        lineup = swapTeamRoles(lineup, e.team);
        cur = { lineup, ms: 0, goals: { AF: 0, AK: 0, BF: 0, BK: 0 } };
      } else {
        // Golün slotu, o anki kadrodan bulunur (kayıttaki role ile aynı olmalı).
        const slot = slotForScorer(lineup, e);
        if (!slot) continue;
        if (e.last_ball) out.races.push({ lineup, scorer: slot });
        else cur.goals[slot]++;
      }
    }
    close(total);
  }
  return out;
}

function slotForScorer(l: Lineup, e: MatchEvent): Slot | null {
  if (!e.player_id) return null;
  if (l[slotOf(e.team, 'F')] === e.player_id) return slotOf(e.team, 'F');
  if (l[slotOf(e.team, 'K')] === e.player_id) return slotOf(e.team, 'K');
  return null;
}

/** Oyuncu başına mevki süreleri (ms) */
export function roleTimes(m: MatchCore, events: MatchEvent[]): Record<string, { F: number; K: number }> {
  const res: Record<string, { F: number; K: number }> = {};
  for (const s of segmentsOf(m, events).segments) {
    for (const slot of ['AF', 'AK', 'BF', 'BK'] as Slot[]) {
      const p = s.lineup[slot];
      res[p] ??= { F: 0, K: 0 };
      res[p][slot[1] as Role] += s.ms;
    }
  }
  return res;
}

export function winnerOf(f: Pick<MatchFacts, 'goalsA' | 'goalsB'>): 'A' | 'B' | 'D' {
  return f.goalsA > f.goalsB ? 'A' : f.goalsB > f.goalsA ? 'B' : 'D';
}
