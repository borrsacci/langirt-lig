import type { BetRule, MatchCore, MatchEvent } from '../../supabase/functions/_shared/types.ts';

export interface Player {
  id: string;
  name: string;
  active: boolean;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  status: 'pending' | 'active' | 'disabled';
  balance: number;
  player_id: string | null;
  created_at: string;
}

export interface MatchRow extends MatchCore {
  created_by: string;
  half: 1 | 2;
  clock_running: boolean;
  clock_remaining_ms: number;
  clock_updated_at: string;
  last_ball: boolean;
  ended_early: boolean;
  started_at: string | null;
  finished_at: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  bets_voided: boolean;
  decision_note: string | null;
  model: ModelSnapshot;
  version: number;
}

export interface ModelSnapshot {
  probs?: { A: number; D: number; B: number };
  expectedGoals?: { A: number; B: number };
  nMatches?: number;
  effMatches?: number;
  ratings?: Record<string, { F: number; K: number }>;
  pair?: { A: number; B: number };
}

export interface Market {
  id: string;
  match_id: string;
  code: string;
  title: string;
  sort: number;
}

export interface Selection {
  id: string;
  market_id: string;
  match_id: string;
  code: string;
  label: string;
  rule: BetRule;
  prob: number;
  odds: number | null;
  allowed_players: string[];
  sort: number;
  result: 'won' | 'lost' | 'void' | null;
}

export interface Bet {
  id: string;
  user_id: string;
  match_id: string;
  selection_id: string;
  stake: number;
  commission: number;
  odds: number;
  status: 'open' | 'won' | 'lost' | 'void' | 'cancelled';
  payout: number;
  created_at: string;
  settled_at: string | null;
  selection?: Selection & { market?: Market };
  match?: MatchRow;
}

export interface Transaction {
  id: number;
  amount: number;
  balance_after: number;
  kind: 'signup' | 'bet' | 'payout' | 'refund' | 'admin';
  note: string | null;
  created_at: string;
  match_id: string | null;
}

export interface LeaderRow {
  user_id: string;
  display_name: string;
  balance: number;
  bets_total: number;
  bets_won: number;
  bets_settled: number;
  staked: number;
  returned: number;
  profit: number;
  biggest_win: number;
  best_odds: number;
}

export interface HistoryMatch extends MatchCore {
  ended_early: boolean;
  events: MatchEvent[];
}

export type { MatchEvent };
