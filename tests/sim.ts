// Test yardımcısı: gerçek oyun kurallarıyla rastgele maç üretir.
import { slotRates, type ModelParams } from '../supabase/functions/_shared/model.ts';
import { HALF_MS, type Lineup, type MatchCore, type MatchEvent, SLOTS, type Slot, swapTeamRoles } from '../supabase/functions/_shared/types.ts';

export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idc = 0;
export function simulateMatch(
  truth: ModelParams,
  lineup: Lineup,
  rng: () => number,
  opts: { createdAt?: string; swapProb?: number } = {},
): { match: MatchCore; events: MatchEvent[] } {
  const id = `m${++idc}`;
  const events: MatchEvent[] = [];
  let seq = 0;
  let l = { ...lineup };
  const swapped = { A: false, B: false };
  for (const half of [1, 2] as const) {
    let t = 0;
    // isteğe bağlı: yarı ortasında mevki değişimi
    const swapAt = opts.swapProb && rng() < opts.swapProb ? rng() * HALF_MS : -1;
    const swapTeam = rng() < 0.5 ? 'A' : 'B';
    for (;;) {
      const r = slotRates(truth, l);
      const tot = SLOTS.reduce((s, k) => s + r[k], 0);
      const dt = (-Math.log(1 - rng()) / tot) * 1000;
      if (swapAt >= 0 && !swapped[swapTeam] && t < swapAt && t + dt >= swapAt) {
        t = swapAt;
        swapped[swapTeam] = true;
        events.push(ev(id, ++seq, 'swap', half, t, swapTeam, null, null, null, false, false));
        l = swapTeamRoles(l, swapTeam);
        continue; // hafızasız süreç: kalan süreyi yeniden çek
      }
      if (t + dt > HALF_MS) break;
      t += dt;
      const s = pick(r, tot, rng);
      events.push(goalEv(id, ++seq, half, t, s, l, false));
    }
    const r = slotRates(truth, l);
    const tot = SLOTS.reduce((s, k) => s + r[k], 0);
    events.push(goalEv(id, ++seq, half, HALF_MS, pick(r, tot, rng), l, true));
  }
  const match: MatchCore = {
    id,
    created_at: opts.createdAt ?? new Date().toISOString(),
    status: 'approved',
    a_f: lineup.AF, a_k: lineup.AK, b_f: lineup.BF, b_k: lineup.BK,
    half1_ms: HALF_MS,
    half2_ms: HALF_MS,
  };
  return { match, events };
}

function pick(r: Record<Slot, number>, tot: number, rng: () => number): Slot {
  let u = rng() * tot;
  for (const s of SLOTS) {
    u -= r[s];
    if (u <= 0) return s;
  }
  return 'BK';
}

function goalEv(mid: string, seq: number, half: 1 | 2, t: number, s: Slot, l: Lineup, lastBall: boolean): MatchEvent {
  const team = s[0] as 'A' | 'B';
  const keeper = team === 'A' ? l.BK : l.AK;
  return ev(mid, seq, 'goal', half, t, team, l[s], s[1] as 'F' | 'K', keeper, lastBall, lastBall);
}

function ev(
  match_id: string, seq: number, kind: 'goal' | 'swap', half: 1 | 2, clock_ms: number, team: 'A' | 'B',
  player_id: string | null, role: 'F' | 'K' | null, keeper_id: string | null, last_ball: boolean, ends_half: boolean,
): MatchEvent {
  return { id: `${match_id}-${seq}`, match_id, seq, kind, half, clock_ms: Math.round(clock_ms), team, player_id, role, keeper_id, last_ball, ends_half, deleted_at: null };
}
