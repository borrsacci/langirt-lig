import { useEffect, useState } from 'react';
import { deriveFacts, lineupAfter, liveEvents } from '../../supabase/functions/_shared/game.ts';
import { ruleText } from '../../supabase/functions/_shared/settle.ts';
import { HALF_MS, type Lineup, type Team } from '../../supabase/functions/_shared/types.ts';
import { clock, coin, odds as fmtOdds, pct, when } from '../lib/format';
import { useStore, usePlayerName } from '../lib/store';
import type { Bet, MatchEvent, MatchRow } from '../lib/types';
import { cn, TeamDot } from './kit';

export const teamName = (t: Team) => (t === 'A' ? 'Mavi' : 'Kırmızı');
export const roleName = (r: 'F' | 'K') => (r === 'F' ? 'Forvet' : 'Kaleci');

/** Sunucu saatine göre kalan süre; çalışırken 4 kez/sn güncellenir */
export function useRemaining(m: MatchRow | null): number {
  const offset = useStore((s) => s.offset);
  const calc = () => {
    if (!m) return HALF_MS;
    if (!m.clock_running) return m.clock_remaining_ms;
    const now = Date.now() + offset;
    return Math.max(0, Math.round(m.clock_remaining_ms - (now - Date.parse(m.clock_updated_at))));
  };
  const [v, setV] = useState(calc);
  useEffect(() => {
    setV(calc());
    if (!m?.clock_running) return;
    const t = setInterval(() => setV(calc()), 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.clock_running, m?.clock_remaining_ms, m?.clock_updated_at, offset]);
  return v;
}

/** Langırt masalarındaki boncuklu skor sayacı */
export function Beads({ count, team, total = 10, className }: { count: number; team: Team; total?: number; className?: string }) {
  const shown = Math.min(count, total);
  return (
    <div className={cn('relative flex h-4 items-center gap-[3px]', team === 'B' && 'flex-row-reverse', className)} aria-label={`${count} gol`}>
      <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded bg-chrome/40" />
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'relative size-3.5 rounded-full transition-all duration-300 shadow-[inset_0_-2px_0_rgba(0,0,0,0.3)]',
            i < shown ? (team === 'A' ? 'bg-blue-team' : 'bg-red-team') : 'bg-felt-2',
            i === shown - 1 && 'scale-110',
          )}
          style={{ marginInlineEnd: i === shown - 1 ? 8 : undefined }}
        />
      ))}
    </div>
  );
}

export function TeamLine({ lineup, team, align = 'left', big }: { lineup: Lineup; team: Team; align?: 'left' | 'right'; big?: boolean }) {
  const name = usePlayerName();
  const F = team === 'A' ? lineup.AF : lineup.BF;
  const K = team === 'A' ? lineup.AK : lineup.BK;
  return (
    <div className={cn('min-w-0', align === 'right' && 'text-right')}>
      <div className={cn('flex items-center gap-1.5', align === 'right' && 'flex-row-reverse')}>
        <TeamDot team={team} />
        <span className={cn('text-xs font-semibold', team === 'A' ? 'text-blue-team' : 'text-red-team')}>{teamName(team)}</span>
      </div>
      <div className={cn('truncate font-semibold', big ? 'text-lg' : 'text-[15px]')}>
        {name(F)} <span className="text-xs font-medium text-dim">F</span>
      </div>
      <div className={cn('truncate font-semibold', big ? 'text-lg' : 'text-[15px]')}>
        {name(K)} <span className="text-xs font-medium text-dim">K</span>
      </div>
    </div>
  );
}

export function ProbBar({ probs }: { probs?: { A: number; D: number; B: number } }) {
  if (!probs) return null;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-felt-2">
        <div className="bg-blue-team" style={{ width: `${probs.A * 100}%` }} />
        <div className="bg-chrome/40" style={{ width: `${probs.D * 100}%` }} />
        <div className="bg-red-team" style={{ width: `${probs.B * 100}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-chrome num">
        <span>Mavi {pct(probs.A)}</span>
        <span>Beraberlik {pct(probs.D)}</span>
        <span>Kırmızı {pct(probs.B)}</span>
      </div>
    </div>
  );
}

export function Scoreboard({ match, events }: { match: MatchRow; events: MatchEvent[] }) {
  const f = deriveFacts(events);
  const remaining = useRemaining(match);
  const lineup = lineupAfter(match, events);
  const lastBall = match.status === 'live' && (match.last_ball || (match.clock_running && remaining <= 0));
  return (
    <div className="rounded-3xl bg-felt p-4">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <TeamLine lineup={lineup} team="A" />
        <div className="text-center">
          <div className="font-display text-6xl font-extrabold leading-none num">
            <span className="text-blue-team">{f.goalsA}</span>
            <span className="mx-1.5 text-dim">:</span>
            <span className="text-red-team">{f.goalsB}</span>
          </div>
        </div>
        <TeamLine lineup={lineup} team="B" align="right" />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-6 px-1">
        <Beads count={f.goalsA} team="A" />
        <Beads count={f.goalsB} team="B" />
      </div>
      {match.status === 'live' && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <span className="rounded-full bg-felt-2 px-2.5 py-1 text-xs font-semibold text-chrome">{match.half}. yarı</span>
          {lastBall ? (
            <span className="animate-pulse rounded-full bg-brass px-3 py-1 font-display text-lg font-bold text-pitch">Son top</span>
          ) : (
            <span className={cn('font-display text-4xl font-bold num', !match.clock_running && 'text-chrome')}>{clock(remaining)}</span>
          )}
          {!match.clock_running && !lastBall && <span className="text-xs font-semibold text-brass">Durdu</span>}
        </div>
      )}
      {match.half === 2 && match.status === 'live' && (
        <div className="mt-2 text-center text-xs text-dim num">İlk yarı {f.htA}-{f.htB}</div>
      )}
    </div>
  );
}

export function EventFeed({
  events, canUndo, onUndo,
}: { events: MatchEvent[]; canUndo?: (e: MatchEvent) => boolean; onUndo?: (e: MatchEvent) => void }) {
  const name = usePlayerName();
  const list = liveEvents(events).reverse();
  if (!list.length) return <p className="py-4 text-center text-sm text-dim">Henüz gol yok.</p>;
  // her golden sonraki skor
  const score = new Map<string, string>();
  let a = 0, b = 0;
  for (const e of liveEvents(events)) {
    if (e.kind === 'goal') e.team === 'A' ? a++ : b++;
    score.set(e.id, `${a}-${b}`);
  }
  return (
    <ul className="divide-y divide-line/50">
      {list.map((e) => (
        <li key={e.id} className="flex items-center gap-3 py-2.5">
          <span className="w-14 shrink-0 text-xs leading-tight text-dim num">
            {e.half}. yarı
            <br />
            {e.last_ball ? 'son top' : clock(e.clock_ms)}
          </span>
          <TeamDot team={e.team} />
          <div className="min-w-0 flex-1 text-[15px]">
            {e.kind === 'goal' ? (
              <>
                <span className="font-semibold">{name(e.player_id)}</span>{' '}
                <span className="text-dim">{e.role === 'K' ? 'kaleden' : 'forvetten'}</span>
                {e.ends_half && <span className="ml-1.5 text-xs font-semibold text-brass">{e.half === 1 ? 'ilk yarıyı bitirdi' : 'maçı bitirdi'}</span>}
              </>
            ) : (
              <span className="text-chrome">{teamName(e.team)} mevki değiştirdi</span>
            )}
          </div>
          {e.kind === 'goal' && <span className="font-display text-lg font-bold num">{score.get(e.id)}</span>}
          {canUndo?.(e) && onUndo && (
            <button onClick={() => onUndo(e)} className="rounded-lg bg-felt-2 px-2.5 py-1.5 text-xs font-semibold text-chrome active:bg-line">
              Geri al
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const statusText: Record<Bet['status'], string> = { open: 'Bekliyor', won: 'Kazandı', lost: 'Kaybetti', void: 'İade', cancelled: 'İptal' };

export function BetRow({ bet, live, showUser }: { bet: Bet; live?: 'won' | 'lost' | 'void' | null; showUser?: boolean }) {
  const name = usePlayerName();
  const profiles = useStore((s) => s.profiles);
  const sel = bet.selection;
  const label = sel ? ruleText(sel.rule, name) : 'Seçim';
  const win = Math.round(bet.stake * bet.odds * 100) / 100;
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        {showUser && <div className="text-xs font-semibold text-chrome">{profiles.find((p) => p.id === bet.user_id)?.display_name ?? '?'}</div>}
        <div className="truncate font-semibold">{label}</div>
        <div className="text-xs text-dim num">
          {coin(bet.stake)} × {fmtOdds(bet.odds)} {bet.status === 'open' ? `→ ${coin(win)}` : ''}
        </div>
      </div>
      <div className="text-right">
        {bet.status === 'open' && live ? (
          <span className={cn('text-xs font-semibold', live === 'won' ? 'text-win' : 'text-chrome')}>{live === 'won' ? 'Şu an tutuyor' : 'Şu an tutmuyor'}</span>
        ) : (
          <span
            className={cn(
              'text-sm font-semibold num',
              bet.status === 'won' && 'text-win',
              bet.status === 'lost' && 'text-loss',
              (bet.status === 'void' || bet.status === 'cancelled' || bet.status === 'open') && 'text-chrome',
            )}
          >
            {bet.status === 'won' ? `+${coin(bet.payout)}` : statusText[bet.status]}
          </span>
        )}
      </div>
    </div>
  );
}

export function MatchSummaryLine({ match, events }: { match: { created_at: string } & Pick<MatchRow, 'a_f' | 'a_k' | 'b_f' | 'b_k'>; events: MatchEvent[] }) {
  const name = usePlayerName();
  const f = deriveFacts(events);
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 text-[15px]">
        <div className={cn('truncate', f.goalsA > f.goalsB && 'font-semibold')}>
          <TeamDot team="A" className="mr-1.5" />{name(match.a_f)} & {name(match.a_k)}
        </div>
        <div className={cn('truncate', f.goalsB > f.goalsA && 'font-semibold')}>
          <TeamDot team="B" className="mr-1.5" />{name(match.b_f)} & {name(match.b_k)}
        </div>
      </div>
      <div className="text-right">
        <div className="font-display text-2xl font-bold leading-tight num">{f.goalsA}-{f.goalsB}</div>
        <div className="text-xs text-dim">{when(match.created_at)}</div>
      </div>
    </div>
  );
}
