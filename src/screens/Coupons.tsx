import { useState } from 'react';
import { ruleText } from '../../supabase/functions/_shared/settle.ts';
import { coin, odds, payout, when } from '../lib/format';
import { useStore, usePlayerName } from '../lib/store';
import type { Bet } from '../lib/types';
import { Card, Empty, Segmented, cn } from '../ui/kit';

const STATUS: Record<Bet['status'], [string, string]> = {
  open: ['Bekliyor', 'bg-felt-2 text-chrome'],
  won: ['Kazandı', 'bg-win/15 text-win'],
  lost: ['Kaybetti', 'bg-loss/15 text-loss'],
  void: ['İade', 'bg-felt-2 text-chrome'],
  cancelled: ['İptal', 'bg-felt-2 text-dim'],
};

const matchState: Record<string, string> = {
  open: 'Bahis açık',
  live: 'Maç oynanıyor',
  review: 'Maç bitti, kontrol ediliyor',
  pending: 'Admin onayı bekliyor',
};

export function CouponsScreen() {
  const bets = useStore((s) => s.myBets);
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const name = usePlayerName();
  const list = bets.filter((b) => (tab === 'open' ? b.status === 'open' : b.status !== 'open'));
  const settled = bets.filter((b) => b.status === 'won' || b.status === 'lost');
  const profit = settled.reduce((s, b) => s + (b.status === 'won' ? b.payout : 0) - b.stake, 0);
  const openStake = bets.filter((b) => b.status === 'open').reduce((s, b) => s + b.stake, 0);

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Açık kupon" value={String(bets.filter((b) => b.status === 'open').length)} sub={`${coin(openStake)} coin`} />
        <Stat label="İsabet" value={settled.length ? `${settled.filter((b) => b.status === 'won').length}/${settled.length}` : '—'} />
        <Stat label="Net kazanç" value={(profit > 0 ? '+' : '') + coin(profit)} tone={profit > 0 ? 'win' : profit < 0 ? 'loss' : undefined} />
      </div>
      <Segmented value={tab} onChange={setTab} items={[['open', 'Açık'], ['done', 'Sonuçlanan']]} />
      {list.length === 0 ? (
        <Empty title={tab === 'open' ? 'Açık kuponun yok' : 'Henüz sonuçlanan kupon yok'}>
          {tab === 'open' ? 'Bahis açık bir maç olduğunda Maç sekmesinden oran seçip kupon yapabilirsin.' : undefined}
        </Empty>
      ) : (
        <div className="space-y-2">
          {list.map((b) => {
            const m = b.match;
            const [label, cls] = STATUS[b.status];
            return (
              <Card key={b.id} className="space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{b.selection ? ruleText(b.selection.rule, name) : '—'}</div>
                    <div className="truncate text-xs text-dim">{b.selection?.market?.title}</div>
                  </div>
                  <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', cls)}>{label}</span>
                </div>
                {m && (
                  <div className="text-sm text-chrome">
                    {name(m.a_f)} & {name(m.a_k)} <span className="text-dim">–</span> {name(m.b_f)} & {name(m.b_k)}
                  </div>
                )}
                <div className="flex items-end justify-between border-t border-line/50 pt-2.5 text-sm">
                  <div className="text-dim">
                    {when(b.created_at)}
                    {b.status === 'open' && m && matchState[m.status] && <div className="text-chrome">{matchState[m.status]}</div>}
                  </div>
                  <div className="text-right num">
                    <div className="text-chrome">{coin(b.stake)} × {odds(b.odds)}</div>
                    <div className={cn('font-display text-xl font-bold', b.status === 'won' ? 'text-win' : b.status === 'lost' ? 'text-loss line-through decoration-2' : 'text-brass')}>
                      {b.status === 'won' ? `+${coin(b.payout)}` : b.status === 'void' || b.status === 'cancelled' ? coin(b.stake) : coin(payout(b.stake, b.odds))}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'win' | 'loss' }) {
  return (
    <div className="rounded-2xl bg-felt px-3 py-3">
      <div className="text-xs text-dim">{label}</div>
      <div className={cn('font-display text-2xl font-bold num', tone === 'win' && 'text-win', tone === 'loss' && 'text-loss')}>{value}</div>
      {sub && <div className="text-xs text-dim num">{sub}</div>}
    </div>
  );
}
