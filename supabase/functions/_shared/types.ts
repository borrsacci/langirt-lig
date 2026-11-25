// Paylaşılan alan tipleri. Bu klasördeki dosyalar hem uygulamada (Vite) hem de
// Supabase Edge Function'larında (Deno) çalışır: dış bağımlılık YOK, importlar .ts uzantılı.

/** F = forvet, K = kaleci */
export type Role = 'F' | 'K';
/** Takımlar maç boyunca sabittir. A = Mavi, B = Kırmızı. Devrede sadece masa tarafı değişir. */
export type Team = 'A' | 'B';

export const HALF_MS = 180_000;
export const MIN_STAKE = 2;
export const START_BALANCE = 1000;


export interface Lineup {
  AF: string;
  AK: string;
  BF: string;
  BK: string;
}

export type Slot = keyof Lineup; // 'AF' | 'AK' | 'BF' | 'BK'
export const SLOTS: Slot[] = ['AF', 'AK', 'BF', 'BK'];

export function slotOf(team: Team, role: Role): Slot {
  return (team + role) as Slot;
}

export type MatchStatus =
  | 'open' // kadro kesin, oranlar sabit, bahis açık
  | 'live' // maç oynanıyor, bahis kapalı
  | 'review' // maç bitti, kaydeden kişi kontrol ediyor
  | 'pending' // admin onayı bekliyor
  | 'approved' // onaylandı: istatistiklere ve bahislere işlendi
  | 'rejected' // reddedildi: bahisler iade
  | 'cancelled'; // iptal: bahisler iade

/** Veritabanındaki maç satırının oyun mantığı için gereken kısmı */
export interface MatchCore {
  id: string;
  created_at: string;
  status: MatchStatus;
  a_f: string;
  a_k: string;
  b_f: string;
  b_k: string;
  half1_ms: number | null;
  half2_ms: number | null;
}

export interface MatchEvent {
  id: string;
  match_id: string;
  seq: number;
  kind: 'goal' | 'swap';
  half: 1 | 2;
  clock_ms: number; // o yarıda geçen oyun süresi (ms)
  team: Team;
  player_id: string | null; // gol atan
  role: Role | null; // gol atanın o anki mevkisi
  keeper_id: string | null; // golü yiyen kaleci
  last_ball: boolean; // süre bittikten sonra, son topta atıldı
  ends_half: boolean; // bu gol yarıyı/maçı bitirdi
  deleted_at: string | null;
}

export function initialLineup(m: Pick<MatchCore, 'a_f' | 'a_k' | 'b_f' | 'b_k'>): Lineup {
  return { AF: m.a_f, AK: m.a_k, BF: m.b_f, BK: m.b_k };
}

export function swapTeamRoles(l: Lineup, team: Team): Lineup {
  return team === 'A' ? { ...l, AF: l.AK, AK: l.AF } : { ...l, BF: l.BK, BK: l.BF };
}

export function teamOfPlayer(l: Lineup, playerId: string): Team | null {
  if (l.AF === playerId || l.AK === playerId) return 'A';
  if (l.BF === playerId || l.BK === playerId) return 'B';
  return null;
}

export function other(t: Team): Team {
  return t === 'A' ? 'B' : 'A';
}

export function pairKey(p: string, q: string): string {
  return p < q ? `${p}|${q}` : `${q}|${p}`;
}

// ---------- Bahis kuralları ----------
export type Outcome = 'A' | 'D' | 'B';

export type BetRule =
  | { k: 'ms'; o: Outcome } // maç sonucu
  | { k: 'dc'; o: [Outcome, Outcome] } // çifte şans
  | { k: 'ht'; o: Outcome } // ilk yarı sonucu
  | { k: 'h2'; o: Outcome } // ikinci yarı sonucu (sadece 2. yarıdaki goller)
  | { k: 'htft'; ht: Outcome; ft: Outcome } // ilk yarı / maç sonucu
  | { k: 'htou'; line: number; side: 'over' | 'under' } // ilk yarı toplam gol alt/üst
  | { k: 'ou'; line: number; side: 'over' | 'under' } // toplam gol alt/üst
  | { k: 'tg'; team: Team; line: number; side: 'over' | 'under' } // takımın attığı gol alt/üst
  | { k: 'btts'; yes: boolean } // karşılıklı gol
  | { k: 'pg'; player: string; yes: boolean } // oyuncu gol atar
  | { k: 'pgl'; player: string; line: number; side: 'over' | 'under' } // oyuncu gol sayısı alt/üst
  | { k: 'fg'; player: string }; // ilk golü atan

export type BetResult = 'won' | 'lost' | 'void';

export interface MatchFacts {
  goalsA: number;
  goalsB: number;
  htA: number;
  htB: number;
  playerGoals: Record<string, number>;
  firstScorer: string | null;
}
