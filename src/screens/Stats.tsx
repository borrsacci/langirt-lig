import html2canvas from 'html2canvas';
import { Share2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { roleImpact } from '../../supabase/functions/_shared/model.ts';
import { HALF_MS } from '../../supabase/functions/_shared/types.ts';
import { minutes, pct } from '../lib/format';
import { shareImage } from '../lib/native';
import { type PlayerStat, computeStats, concededPerHalf, goalsPerHalfF, modelOf, topOf, winRate } from '../lib/stats';
import { useStore, usePlayerName } from '../lib/store';
import type { HistoryMatch } from '../lib/types';
import { Button, Card, Empty, Section, Segmented, Sheet, cn, toast } from '../ui/kit';
import { MatchDetail } from './MatchDetail';
import { MatchSummaryLine } from '../ui/match';

type View = 'players' | 'power' | 'pairs' | 'records' | 'matches';
const dec = (x: number | null, d = 1) => (x === null ? '—' : x.toFixed(d).replace('.', ','));

export function StatsScreen() {
  const history = useStore((s) => s.history);
  const [view, setView] = useState<View>('players');
  const stats = useMemo(() => computeStats(history), [history]);

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-3 gap-2 text-center">
        <Mini label="Maç" value={String(stats.totalMatches)} />
        <Mini label="Gol" value={String(stats.totalGoals)} />
        <Mini label="Maç başı gol" value={stats.totalMatches ? dec(stats.totalGoals / stats.totalMatches) : '—'} />
      </div>
      <Segmented
        value={view}
        onChange={setView}
        items={[['players', 'Oyuncular'], ['power', 'Güç'], ['pairs', 'İkililer'], ['records', 'Enler'], ['matches', 'Maçlar']]}
      />
      {stats.totalMatches === 0 ? (
        <Empty title="Henüz onaylı maç yok">İlk maç oynanıp admin onaylayınca istatistikler burada görünür.</Empty>
      ) : (
        <>
          {view === 'players' && <PlayersView stats={stats.players} />}
          {view === 'power' && <PowerView history={history} stats={stats.players} />}
          {view === 'pairs' && <PairsView pairs={stats.pairs} />}
          {view === 'records' && <RecordsView stats={stats} />}
          {view === 'matches' && <MatchesView history={history} />}
        </>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-felt py-2.5">
      <div className="font-display text-2xl font-bold num">{value}</div>
      <div className="text-xs text-dim">{label}</div>
    </div>
  );
}

function Form({ form }: { form: PlayerStat['form'] }) {
  return (
    <span className="flex gap-0.5">
      {form.map((r, i) => (
        <span key={i} className={cn('size-2 rounded-full', r === 'G' ? 'bg-win' : r === 'M' ? 'bg-loss' : 'bg-chrome/60')} />
      ))}
    </span>
  );
}

function PlayersView({ stats }: { stats: Record<string, PlayerStat> }) {
  const name = usePlayerName();
  const [sort, setSort] = useState<'win' | 'goals' | 'played'>('win');
  const [sel, setSel] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const list = Object.values(stats).sort((a, b) =>
    sort === 'goals' ? b.goals - a.goals || winRate(b) - winRate(a)
      : sort === 'played' ? b.played - a.played
        : winRate(b) - winRate(a) || b.played - a.played || b.goals - a.goals,
  );

  const share = async () => {
    if (!ref.current) return;
    try {
      const canvas = await html2canvas(ref.current, { backgroundColor: '#0a2a21', scale: 2 });
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
      if (!blob) throw new Error();
      await shareImage(blob, 'langirt-ligi.png', 'Langırt Ligi');
    } catch (e) {
      if (!/cancel|abort/i.test(String((e as Error)?.message ?? e))) toast('Görsel paylaşılamadı', 'error');
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Segmented className="flex-1" value={sort} onChange={setSort} items={[['win', 'Kazanma'], ['goals', 'Gol'], ['played', 'Maç']]} />
        <Button size="sm" onClick={share}><Share2 size={16} /> Paylaş</Button>
      </div>
      <div ref={ref} className="space-y-1.5 bg-pitch">
        <div className="grid grid-cols-[1.5rem_1fr_2.5rem_4.5rem_2.75rem_2.5rem] gap-1 px-3 text-xs text-dim">
          <span /> <span>Oyuncu</span> <span className="text-center">Maç</span> <span className="text-center">G-B-M</span> <span className="text-right">%</span> <span className="text-right">Gol</span>
        </div>
        {list.map((s, i) => (
          <button key={s.id} onClick={() => setSel(s.id)} className="grid w-full grid-cols-[1.5rem_1fr_2.5rem_4.5rem_2.75rem_2.5rem] items-center gap-1 rounded-xl bg-felt px-3 py-3 text-left active:bg-felt-2">
            <span className="text-sm font-semibold text-dim num">{i + 1}</span>
            <span className="min-w-0">
              <span className="block truncate font-semibold">{name(s.id)}</span>
              <Form form={s.form} />
            </span>
            <span className="text-center text-chrome num">{s.played}</span>
            <span className="text-center text-sm num">
              <span className="text-win">{s.won}</span>-<span className="text-chrome">{s.drawn}</span>-<span className="text-loss">{s.lost}</span>
            </span>
            <span className="text-right font-semibold num">{Math.round(winRate(s) * 100)}</span>
            <span className="text-right font-display text-lg font-bold num">{s.goals}</span>
          </button>
        ))}
      </div>
      <PlayerSheet stat={sel ? stats[sel] : null} onClose={() => setSel(null)} />
    </>
  );
}

function PlayerSheet({ stat, onClose }: { stat: PlayerStat | null; onClose: () => void }) {
  const name = usePlayerName();
  const history = useStore((s) => s.history);
  const model = useMemo(() => modelOf(history), [history]);
  const s = stat;
  const victim = s ? topOf(s.scoredAgainst) : null;
  const nemesis = s ? topOf(s.concededFrom) : null;
  const imp = s ? roleImpact(model, s.id) : null;
  return (
    <Sheet open={!!s} onClose={onClose} title={s ? name(s.id) : ''}>
      {s && imp && (
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-2 text-center">
            <Mini label="Maç" value={String(s.played)} />
            <Mini label="Kazanma" value={pct(winRate(s))} />
            <Mini label="Gol" value={String(s.goals)} />
          </div>
          <Block title="Forvetken" rows={[
            ['Oynadığı süre', minutes(s.msF)],
            ['Attığı gol', String(s.goalsF)],
            ['Yarı başına gol', dec(goalsPerHalfF(s), 2)],
            ['Güç', s.msF ? (imp.F > 0 ? '+' : '') + dec(imp.F, 2) : '—'],
            ['En çok gol attığı kaleci', victim ? `${name(victim[0])} (${victim[1]})` : '—'],
          ]} />
          <Block title="Kaleciyken" rows={[
            ['Oynadığı süre', minutes(s.msK)],
            ['Attığı gol', String(s.goalsK)],
            ['Yediği gol', String(s.conceded)],
            ['Yarı başına yediği', dec(concededPerHalf(s), 2)],
            ['Güç', s.msK ? (imp.K > 0 ? '+' : '') + dec(imp.K, 2) : '—'],
            ['En çok gol yediği oyuncu', nemesis ? `${name(nemesis[0])} (${nemesis[1]})` : '—'],
          ]} />
          <p className="text-xs leading-relaxed text-dim">
            Güç: ortalama bir takım arkadaşı ve ortalama rakiplerle, 3 dakikalık bir yarıda takımına kazandırdığı beklenen gol farkı. Oranlar da bu modelle hesaplanır.
          </p>
        </div>
      )}
    </Sheet>
  );
}

function Block({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div>
      <div className="mb-1.5 font-display text-lg font-bold">{title}</div>
      <div className="divide-y divide-line/50 rounded-2xl bg-pitch px-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-2.5 text-[15px]">
            <span className="text-chrome">{k}</span>
            <span className="font-semibold num">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PowerView({ history, stats }: { history: HistoryMatch[]; stats: Record<string, PlayerStat> }) {
  const name = usePlayerName();
  const model = useMemo(() => modelOf(history), [history]);
  const rows = (role: 'F' | 'K') =>
    Object.values(stats)
      .filter((s) => (role === 'F' ? s.msF : s.msK) >= HALF_MS / 3)
      .map((s) => ({ s, v: roleImpact(model, s.id)[role] }))
      .sort((a, b) => b.v - a.v);
  const max = Math.max(0.01, ...[...rows('F'), ...rows('K')].map((r) => Math.abs(r.v)));
  const List = ({ role }: { role: 'F' | 'K' }) => (
    <Card className="space-y-2.5">
      {rows(role).map(({ s, v }, i) => (
        <div key={s.id} className="grid grid-cols-[1.25rem_6.5rem_1fr_3rem] items-center gap-2">
          <span className="text-sm text-dim num">{i + 1}</span>
          <span className="truncate font-semibold">{name(s.id)}</span>
          <span className="relative h-2 rounded-full bg-pitch">
            <span className="absolute left-1/2 top-0 h-2 w-px bg-line" />
            <span
              className={cn('absolute top-0 h-2 rounded-full', v >= 0 ? 'left-1/2 bg-win' : 'right-1/2 bg-loss')}
              style={{ width: `${(Math.abs(v) / max) * 50}%` }}
            />
          </span>
          <span className="text-right text-sm font-semibold num">{(v > 0 ? '+' : '') + dec(v, 2)}</span>
        </div>
      ))}
      {rows(role).length === 0 && <p className="text-sm text-dim">Bu mevkide yeterli süre oynayan yok.</p>}
    </Card>
  );
  return (
    <div className="space-y-5">
      <p className="px-1 text-sm leading-relaxed text-dim">
        Oranları hesaplayan modelin gördüğü güç: oyuncunun o mevkide 3 dakikada takımına kazandırdığı beklenen gol farkı. Son maçlar daha ağır basar.
      </p>
      <Section title="Forvetler"><List role="F" /></Section>
      <Section title="Kaleciler"><List role="K" /></Section>
    </div>
  );
}

function PairsView({ pairs }: { pairs: ReturnType<typeof computeStats>['pairs'] }) {
  const name = usePlayerName();
  const list = [...pairs].sort((a, b) => winRate(b) - winRate(a) || b.played - a.played || b.gf - b.ga - (a.gf - a.ga));
  return (
    <div className="space-y-1.5">
      {list.map((p) => (
        <div key={p.key} className="flex items-center gap-3 rounded-xl bg-felt px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{name(p.a)} & {name(p.b)}</div>
            <div className="text-xs text-dim num">
              {p.played} maç · averaj {p.gf - p.ga > 0 ? '+' : ''}{p.gf - p.ga}
            </div>
          </div>
          <div className="text-right text-sm num">
            <span className="text-win">{p.won}</span>-<span className="text-chrome">{p.drawn}</span>-<span className="text-loss">{p.lost}</span>
          </div>
          <div className="w-12 text-right font-display text-xl font-bold num">{pct(winRate(p))}</div>
        </div>
      ))}
    </div>
  );
}

function RecordsView({ stats }: { stats: ReturnType<typeof computeStats> }) {
  const name = usePlayerName();
  const all = Object.values(stats.players);
  const best = <T,>(arr: T[], score: (x: T) => number | null, dir: 1 | -1 = 1) => {
    let r: { x: T; v: number } | null = null;
    for (const x of arr) {
      const v = score(x);
      if (v === null || !Number.isFinite(v)) continue;
      if (!r || v * dir > r.v * dir) r = { x, v };
    }
    return r;
  };
  const minK = all.filter((s) => s.msK >= HALF_MS * 2);
  const minF = all.filter((s) => s.msF >= HALF_MS * 2);
  const recs: [string, string, { x: PlayerStat; v: number } | null, (v: number) => string][] = [
    ['Gol kralı', 'En çok gol atan', best(all, (s) => s.goals), (v) => `${v} gol`],
    ['Duvar', 'Kaleciyken yarı başına en az gol yiyen', best(minK, concededPerHalf, -1), (v) => `${dec(v, 2)} gol`],
    ['Keskin nişancı', 'Forvetken yarı başına en çok gol atan', best(minF, goalsPerHalfF), (v) => `${dec(v, 2)} gol`],
    ['Kral', 'En çok kazanan', best(all, (s) => s.won), (v) => `${v} galibiyet`],
    ['Seri katil', 'En uzun galibiyet serisi', best(all, (s) => s.streak), (v) => `${v} maç üst üste`],
    ['Şanssız', 'En çok kaybeden', best(all, (s) => s.lost), (v) => `${v} mağlubiyet`],
    ['Kova', 'Kaleciyken en çok gol yiyen', best(all, (s) => s.conceded), (v) => `${v} gol`],
  ];
  const bw = stats.biggestWin;
  return (
    <div className="grid grid-cols-2 gap-2">
      {recs.map(([t, d, r, f]) => (
        <Card key={t} className="space-y-1">
          <div className="font-display text-lg font-bold">{t}</div>
          <div className="text-xs leading-snug text-dim">{d}</div>
          {r && r.v > 0 ? (
            <div className="pt-1.5">
              <div className="truncate font-semibold">{name(r.x.id)}</div>
              <div className="text-sm text-brass num">{f(r.v)}</div>
            </div>
          ) : (
            <div className="pt-1.5 text-sm text-dim">Yeterli veri yok</div>
          )}
        </Card>
      ))}
      <Card className="space-y-1">
        <div className="font-display text-lg font-bold">Fark attı</div>
        <div className="text-xs text-dim">En farklı biten maç</div>
        {bw ? (
          <div className="pt-1.5 text-sm">
            <div className="font-semibold num">{bw.a}-{bw.b}</div>
            <div className="truncate text-chrome">
              {bw.a > bw.b ? `${name(bw.match.a_f)} & ${name(bw.match.a_k)}` : `${name(bw.match.b_f)} & ${name(bw.match.b_k)}`}
            </div>
          </div>
        ) : (
          <div className="pt-1.5 text-sm text-dim">—</div>
        )}
      </Card>
    </div>
  );
}

function MatchesView({ history }: { history: HistoryMatch[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const list = [...history].reverse();
  return (
    <>
      <div className="space-y-1.5">
        {list.map((m) => (
          <button key={m.id} onClick={() => setSel(m.id)} className="w-full rounded-xl bg-felt px-4 py-3 text-left active:bg-felt-2">
            <MatchSummaryLine match={m} events={m.events} />
          </button>
        ))}
      </div>
      <MatchDetail matchId={sel} onClose={() => setSel(null)} />
    </>
  );
}
