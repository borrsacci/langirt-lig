import { useState } from 'react';
import { START_BALANCE } from '../../supabase/functions/_shared/types.ts';
import { coin, odds, pct, signed } from '../lib/format';
import { useStore } from '../lib/store';
import type { LeaderRow } from '../lib/types';
import { Coin, Empty, Segmented, cn } from '../ui/kit';

type K = 'balance' | 'profit' | 'hit' | 'win' | 'odds';
const MIN_FOR_HIT = 5;

const defs: Record<K, { label: string; hint: string; value: (r: LeaderRow) => number | null; show: (r: LeaderRow) => string }> = {
  balance: { label: 'Kasa', hint: 'Şu anki coin bakiyesi', value: (r) => r.balance, show: (r) => coin(r.balance) },
  profit: { label: 'Kâr', hint: 'Sonuçlanan kuponlardan net kazanç', value: (r) => r.profit, show: (r) => signed(r.profit) },
  hit: {
    label: 'İsabet',
    hint: `Tutan kupon oranı (en az ${MIN_FOR_HIT} sonuçlanan kupon)`,
    value: (r) => (r.bets_settled >= MIN_FOR_HIT ? r.bets_won / r.bets_settled : null),
    show: (r) => `${pct(r.bets_won / r.bets_settled)} · ${r.bets_won}/${r.bets_settled}`,
  },
  win: { label: 'Vurgun', hint: 'Tek kupondan en büyük net kazanç', value: (r) => (r.biggest_win > 0 ? r.biggest_win : null), show: (r) => signed(r.biggest_win) },
  odds: { label: 'Sürpriz', hint: 'Tutturulan en yüksek oran', value: (r) => (r.best_odds > 0 ? r.best_odds : null), show: (r) => odds(r.best_odds) },
};

export function RanksScreen() {
  const rows = useStore((s) => s.leaderboard);
  const me = useStore((s) => s.me)!;
  const [k, setK] = useState<K>('balance');
  const d = defs[k];
  const ranked = rows
    .map((r) => ({ r, v: d.value(r) }))
    .filter((x): x is { r: LeaderRow; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v || a.r.display_name.localeCompare(b.r.display_name, 'tr'));

  return (
    <div className="space-y-4 pt-2">
      <Segmented value={k} onChange={setK} items={(Object.keys(defs) as K[]).map((x) => [x, defs[x].label])} />
      <p className="px-1 text-sm text-dim">{d.hint}</p>
      {ranked.length === 0 ? (
        <Empty title="Henüz sıralama yok">Kuponlar sonuçlandıkça burası dolacak.</Empty>
      ) : (
        <ol className="space-y-1.5">
          {ranked.map(({ r }, i) => (
            <li
              key={r.user_id}
              className={cn('flex items-center gap-3 rounded-xl px-4 py-3', r.user_id === me.id ? 'bg-felt-2 ring-1 ring-brass/40' : 'bg-felt')}
            >
              <span className={cn('w-7 font-display text-2xl font-bold num', i === 0 ? 'text-brass' : 'text-dim')}>{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{r.display_name}</div>
                <div className="text-xs text-dim num">
                  {r.bets_total} kupon
                  {k === 'balance' && ` · başlangıca göre ${signed(r.balance - START_BALANCE)}`}
                </div>
              </div>
              {k === 'balance' ? (
                <Coin value={d.show(r)} className="font-display text-xl text-brass" />
              ) : (
                <span className={cn('font-display text-xl font-bold num', k === 'profit' && (r.profit > 0 ? 'text-win' : r.profit < 0 ? 'text-loss' : ''))}>
                  {d.show(r)}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
