import { useState } from 'react';
import { coin, signed } from '../lib/format';
import { useStore } from '../lib/store';
import { AllBetsByMatch, BetCard, totals } from '../ui/bets';
import { Empty, Segmented, cn } from '../ui/kit';

export function CouponsScreen() {
  const bets = useStore((s) => s.myBets);
  const [tab, setTab] = useState<'open' | 'done' | 'all'>('open');
  const list = bets.filter((b) => (tab === 'open' ? b.status === 'open' : b.status !== 'open'));
  const t = totals(bets);

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Açık kupon" value={String(bets.filter((b) => b.status === 'open').length)} sub={`${coin(t.open)} coin`} />
        <Stat label="İsabet" value={t.settled ? `${t.won}/${t.settled}` : '—'} />
        <Stat label="Net kazanç" value={signed(t.net)} tone={t.net > 0 ? 'win' : t.net < 0 ? 'loss' : undefined} />
      </div>
      <Segmented value={tab} onChange={setTab} items={[['open', 'Açık'], ['done', 'Sonuçlanan'], ['all', 'Herkes']]} />
      {tab === 'all' ? (
        <AllBetsByMatch />
      ) : list.length === 0 ? (
        <Empty title={tab === 'open' ? 'Açık kuponun yok' : 'Henüz sonuçlanan kupon yok'}>
          {tab === 'open'
            ? 'Bahis açık bir maç olduğunda Maç sekmesinden oran seçip kupon yapabilirsin. Aynı maça istediğin kadar kupon yapabilirsin.'
            : undefined}
        </Empty>
      ) : (
        <div className="space-y-2">
          {list.map((b) => (
            <BetCard key={b.id} b={b} />
          ))}
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
