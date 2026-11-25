import { ruleText } from '../../supabase/functions/_shared/settle.ts';
import { betNet, betWin, coin, odds, signed, when } from '../lib/format';
import { useStore, usePlayerName } from '../lib/store';
import type { Bet } from '../lib/types';
import { Card, Sheet, cn } from './kit';

export const STATUS: Record<Bet['status'], [string, string]> = {
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

/** Tek kupon kartı */
export function BetCard({ b, showUser }: { b: Bet; showUser?: boolean }) {
  const name = usePlayerName();
  const profiles = useStore((s) => s.profiles);
  const m = b.match;
  const [label, cls] = STATUS[b.status];
  const net = betNet(b);
  return (
    <Card className="space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {showUser && <div className="text-sm font-semibold text-brass">{profiles.find((p) => p.id === b.user_id)?.display_name ?? '?'}</div>}
          <div className="truncate font-semibold">{b.selection ? ruleText(b.selection.rule, name) : '—'}</div>
          <div className="truncate text-xs text-dim">{b.selection?.market?.title}</div>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', cls)}>{label}</span>
      </div>
      {m && !showUser && (
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
          <div className="text-chrome">
            {coin(b.stake)} × {odds(b.odds)}
          </div>
          <div className={cn('font-display text-xl font-bold', net === null ? 'text-brass' : net > 0 ? 'text-win' : net < 0 ? 'text-loss' : 'text-chrome')}>
            {net === null ? `${coin(betWin(b))} olası` : net === 0 ? 'İade' : signed(net)}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** Kuponların net sonucu: kazanılan − yatırılan (iadeler hariç) */
export function totals(bets: Bet[]) {
  let staked = 0, ret = 0, won = 0, settled = 0, open = 0;
  for (const b of bets) {
    if (b.status === 'won' || b.status === 'lost') {
      settled++;
      staked += b.stake;
      if (b.status === 'won') {
        won++;
        ret += b.payout;
      }
    }
    if (b.status === 'open') open += b.stake;
  }
  return { staked, ret, net: Math.round((ret - staked) * 100) / 100, won, settled, open };
}

/** Herkesin kuponları, maç maç gruplanmış */
export function AllBetsByMatch() {
  const bets = useStore((s) => s.allBets);
  const name = usePlayerName();
  const profiles = useStore((s) => s.profiles);
  const groups = new Map<string, Bet[]>();
  for (const b of bets) groups.set(b.match_id, [...(groups.get(b.match_id) ?? []), b]);
  if (!groups.size)
    return <p className="px-6 py-12 text-center text-sm text-dim">Henüz görünen kupon yok. Kuponlar maç başlayınca herkese açılır.</p>;
  return (
    <div className="space-y-5">
      {[...groups.values()].map((list) => {
        const m = list[0].match;
        const byUser = new Map<string, Bet[]>();
        for (const b of list) byUser.set(b.user_id, [...(byUser.get(b.user_id) ?? []), b]);
        return (
          <section key={list[0].match_id} className="space-y-2">
            {m && (
              <div className="flex items-baseline justify-between px-1">
                <h3 className="font-display text-lg font-bold">
                  {name(m.a_f)} & {name(m.a_k)} – {name(m.b_f)} & {name(m.b_k)}
                </h3>
                <span className="shrink-0 pl-2 text-xs text-dim">{when(m.created_at)}</span>
              </div>
            )}
            <Card className="divide-y divide-line/50 py-0">
              {[...byUser.entries()].map(([uid, ub]) => {
                const t = totals(ub);
                return (
                  <div key={uid} className="py-3">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="font-semibold">{profiles.find((p) => p.id === uid)?.display_name ?? '?'}</span>
                      {t.settled > 0 && (
                        <span className={cn('font-display text-lg font-bold num', t.net > 0 ? 'text-win' : t.net < 0 ? 'text-loss' : 'text-chrome')}>{signed(t.net)}</span>
                      )}
                    </div>
                    {ub.map((b) => {
                      const net = betNet(b);
                      return (
                        <div key={b.id} className="flex items-center justify-between gap-2 py-0.5 text-sm">
                          <span className="min-w-0 truncate text-chrome">{b.selection ? ruleText(b.selection.rule, name) : '—'}</span>
                          <span className="shrink-0 text-dim num">
                            {coin(b.stake)} × {odds(b.odds)}{' '}
                            <span className={cn('font-semibold', net === null ? 'text-chrome' : net > 0 ? 'text-win' : net < 0 ? 'text-loss' : 'text-chrome')}>
                              {net === null ? 'bekliyor' : net === 0 ? 'iade' : signed(net)}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </Card>
          </section>
        );
      })}
    </div>
  );
}

/** Bir kişinin tüm (görünen) kuponları ve toplam kâr/zararı */
export function UserBetsSheet({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const all = useStore((s) => s.allBets);
  const profiles = useStore((s) => s.profiles);
  const bets = all.filter((b) => b.user_id === userId);
  const t = totals(bets);
  const p = profiles.find((x) => x.id === userId);
  return (
    <Sheet open={!!userId} onClose={onClose} title={p?.display_name}>
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Mini label="Kasa" value={coin(p?.balance ?? 0)} />
          <Mini label="İsabet" value={t.settled ? `${t.won}/${t.settled}` : '—'} />
          <Mini label="Net" value={signed(t.net)} tone={t.net > 0 ? 'win' : t.net < 0 ? 'loss' : undefined} />
        </div>
        <p className="text-xs text-dim">Bahsi henüz açık olan maçlardaki kuponlar maç başlayınca görünür.</p>
        {bets.length === 0 ? (
          <p className="py-6 text-center text-sm text-dim">Görünen kuponu yok.</p>
        ) : (
          <div className="space-y-2">
            {bets.map((b) => (
              <BetCard key={b.id} b={b} />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: 'win' | 'loss' }) {
  return (
    <div className="rounded-2xl bg-pitch py-2.5">
      <div className={cn('font-display text-xl font-bold num', tone === 'win' && 'text-win', tone === 'loss' && 'text-loss')}>{value}</div>
      <div className="text-xs text-dim">{label}</div>
    </div>
  );
}
