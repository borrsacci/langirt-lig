import { ArrowLeftRight, Info, Lock, Pause, Play, Shuffle, Users } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { drawTeams } from '../../supabase/functions/_shared/draw.ts';
import { deriveFacts, hasSwapped, lineupAfter, liveEvents } from '../../supabase/functions/_shared/game.ts';
import { settleRule } from '../../supabase/functions/_shared/settle.ts';
import { HALF_MS, type Lineup, MIN_STAKE, type Team, initialLineup } from '../../supabase/functions/_shared/types.ts';
import { invoke, rpc } from '../lib/api';
import { coin, odds as fmtOdds, payout, pct } from '../lib/format';
import { keepAwake, onResume, thump, whistle } from '../lib/native';
import { pairCounts } from '../lib/stats';
import { useStore, usePlayerName } from '../lib/store';
import type { MatchEvent, MatchRow, Selection } from '../lib/types';
import { Button, Card, Coin, Empty, Section, Sheet, TeamDot, cn, confirm, inputCls, toast } from '../ui/kit';
import { BetRow, EventFeed, ProbBar, Scoreboard, TeamLine, roleName, teamName, useRemaining } from '../ui/match';

export function MatchScreen() {
  const current = useStore((s) => s.current);
  if (!current) return <Setup />;
  if (current.status === 'open') return <OpenView match={current} />;
  if (current.status === 'live') return <LiveView match={current} />;
  return <ReviewView match={current} />;
}

function useCanControl(m: MatchRow) {
  const me = useStore((s) => s.me)!;
  return me.is_admin || m.created_by === me.id || (!!me.player_id && [m.a_f, m.a_k, m.b_f, m.b_k].includes(me.player_id));
}

// =====================================================================
// Kura / kadro kurma
// =====================================================================
function Setup() {
  const players = useStore((s) => s.players).filter((p) => p.active);
  const history = useStore((s) => s.history);
  const queue = useStore((s) => s.queue);
  const refresh = useStore((s) => s.refresh);
  const isAdmin = useStore((s) => s.me?.is_admin);
  const name = usePlayerName();
  const [picked, setPicked] = useState<string[]>([]);
  const [lineup, setLineup] = useState<Lineup | null>(null);
  const [manual, setManual] = useState(false);
  const [drawKey, setDrawKey] = useState(0);

  const toggle = (id: string) => {
    setLineup(null);
    setManual(false);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < 4 ? [...p, id] : p));
  };
  const draw = () => {
    setManual(false);
    setLineup(drawTeams(picked, pairCounts(history)));
    setDrawKey((k) => k + 1);
  };
  const swap = (t: Team) =>
    setLineup((l) => (l ? (t === 'A' ? { ...l, AF: l.AK, AK: l.AF } : { ...l, BF: l.BK, BK: l.BF }) : l));

  const open = async () => {
    if (!lineup) return;
    await invoke('create-match', { lineup });
    await refresh('current');
    toast('Bahisler açıldı');
  };

  const waiting = queue.length;

  return (
    <div className="space-y-6 pt-2">
      {waiting > 0 && (
        <Card className="border border-brass/30 bg-brass/10 text-sm text-brass">
          {waiting === 1 ? 'Son maç admin onayı bekliyor.' : `${waiting} maç admin onayı bekliyor.`} Onaylanınca istatistiklere ve kuponlara işlenir.
        </Card>
      )}

      <Section title="Yeni maç" action={<span className="text-sm font-semibold text-chrome num">{picked.length}/4 oyuncu</span>}>
        {players.length < 4 ? (
          <Card className="text-sm leading-relaxed text-chrome">
            Maç için en az 4 aktif oyuncu gerekiyor.{' '}
            {isAdmin
              ? 'Arkadaşların uygulamadan hesap açınca Profil → Admin paneli → Kullanıcılar bölümünden onaylayın; uygulaması olmayanları Oyuncular bölümünden ekleyin.'
              : 'Oyuncular hesap açıp admin onaylayınca burada görünür.'}
          </Card>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {players.map((p) => {
              const i = picked.indexOf(p.id);
              const sel = i >= 0;
              return (
                <button
                  key={p.id}
                  onClick={() => toggle(p.id)}
                  disabled={!sel && picked.length >= 4}
                  className={cn(
                    'relative h-14 rounded-xl px-2 text-[15px] font-semibold transition-colors disabled:opacity-35',
                    sel ? 'bg-chalk text-pitch' : 'bg-felt text-chalk active:bg-felt-2',
                  )}
                >
                  <span className="line-clamp-1">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </Section>

      {picked.length === 4 && !lineup && !manual && (
        <div className="grid grid-cols-[1.6fr_1fr] gap-2">
          <Button variant="brass" size="lg" onClick={draw}>
            <Shuffle size={20} /> Kura çek
          </Button>
          <Button size="lg" onClick={() => setManual(true)}>
            <Users size={18} /> Elle diz
          </Button>
        </div>
      )}

      {manual && !lineup && <ManualLineup picked={picked} onDone={setLineup} onCancel={() => setManual(false)} />}

      {lineup && (
        <motion.div key={drawKey} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {(['A', 'B'] as const).map((t) => (
              <div key={t} className={cn('rounded-2xl p-3.5', t === 'A' ? 'bg-blue-team/15' : 'bg-red-team/15')}>
                <div className="mb-2 flex items-center justify-between">
                  <span className={cn('font-display text-lg font-bold', t === 'A' ? 'text-blue-team' : 'text-red-team')}>{teamName(t)}</span>
                  <button onClick={() => swap(t)} className="flex items-center gap-1 rounded-lg bg-black/20 px-2 py-1 text-xs font-semibold text-chrome active:bg-black/30">
                    <ArrowLeftRight size={13} /> Mevki
                  </button>
                </div>
                {(['F', 'K'] as const).map((r) => (
                  <div key={r} className="flex items-baseline justify-between py-1">
                    <span className="truncate text-[17px] font-semibold">{name(lineup[`${t}${r}`])}</span>
                    <span className="ml-2 text-xs text-chrome">{roleName(r)}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p className="px-1 text-sm text-dim">
            Bahsi açınca kadro ve oranlar kesinleşir. Mevkiler maç içinde her takım için bir kez değiştirilebilir.
          </p>
          <div className="grid grid-cols-[1fr_1.6fr] gap-2">
            <Button onClick={draw}>
              <Shuffle size={18} /> Yeniden
            </Button>
            <Button variant="brass" onClick={open}>Oranları çıkar, bahsi aç</Button>
          </div>
          <Button variant="quiet" className="w-full" onClick={() => { setLineup(null); setManual(false); }}>Kadroyu sıfırla</Button>
        </motion.div>
      )}

      <RecentStrip />
    </div>
  );
}

function ManualLineup({ picked, onDone, onCancel }: { picked: string[]; onDone: (l: Lineup) => void; onCancel: () => void }) {
  const name = usePlayerName();
  const [slots, setSlots] = useState<Partial<Lineup>>({});
  const order: [keyof Lineup, string][] = [['AF', 'Mavi forvet'], ['AK', 'Mavi kaleci'], ['BF', 'Kırmızı forvet'], ['BK', 'Kırmızı kaleci']];
  const assign = (slot: keyof Lineup, id: string) =>
    setSlots((s) => {
      const n: Partial<Lineup> = {};
      for (const [k, v] of Object.entries(s)) if (v !== id) n[k as keyof Lineup] = v;
      n[slot] = id;
      return n;
    });
  const complete = order.every(([k]) => slots[k]);
  return (
    <Card className="space-y-4">
      {order.map(([k, label]) => (
        <div key={k}>
          <div className={cn('mb-1.5 text-sm font-semibold', k[0] === 'A' ? 'text-blue-team' : 'text-red-team')}>{label}</div>
          <div className="grid grid-cols-4 gap-1.5">
            {picked.map((id) => (
              <button
                key={id}
                onClick={() => assign(k, id)}
                className={cn('h-10 truncate rounded-lg px-1 text-sm font-semibold', slots[k] === id ? 'bg-chalk text-pitch' : 'bg-felt-2 text-chrome')}
              >
                {name(id)}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <Button className="flex-1" onClick={onCancel}>Vazgeç</Button>
        <Button className="flex-[1.6]" variant="primary" disabled={!complete} onClick={() => onDone(slots as Lineup)}>Kadroyu kullan</Button>
      </div>
    </Card>
  );
}

function RecentStrip() {
  const history = useStore((s) => s.history);
  const name = usePlayerName();
  const last = [...history].slice(-3).reverse();
  if (!last.length) return null;
  return (
    <Section title="Son maçlar">
      <Card className="divide-y divide-line/50 py-1">
        {last.map((m) => {
          const f = deriveFacts(m.events);
          return (
            <div key={m.id} className="flex items-center justify-between py-2.5 text-[15px]">
              <span className={cn('truncate', f.goalsA > f.goalsB && 'font-semibold')}>{name(m.a_f)} & {name(m.a_k)}</span>
              <span className="mx-3 shrink-0 font-display text-lg font-bold num">{f.goalsA}-{f.goalsB}</span>
              <span className={cn('truncate text-right', f.goalsB > f.goalsA && 'font-semibold')}>{name(m.b_f)} & {name(m.b_k)}</span>
            </div>
          );
        })}
      </Card>
    </Section>
  );
}

// =====================================================================
// Bahis açık
// =====================================================================
function OpenView({ match }: { match: MatchRow }) {
  const canControl = useCanControl(match);
  const me = useStore((s) => s.me)!;
  const bets = useStore((s) => s.matchBets).filter((b) => b.user_id === me.id && b.status === 'open');
  const markets = useStore((s) => s.markets);
  const setCurrent = useStore((s) => s.setCurrent);
  const refresh = useStore((s) => s.refresh);
  const lineup = initialLineup(match);

  const start = async () => {
    if (!(await confirm('Maç başlasın mı?', 'Bahisler kapanacak ve 3 dakikalık ilk yarı saati hemen başlayacak.', 'Başlat'))) return;
    setCurrent(await rpc<MatchRow>('start_match', { p_match: match.id }));
    thump();
  };
  const cancel = async () => {
    if (!(await confirm('Maç iptal edilsin mi?', 'Bu maça yapılan tüm bahisler iade edilir.', 'İptal et', true))) return;
    await rpc('cancel_match', { p_match: match.id });
    await refresh('current', 'me', 'myBets');
    toast('Maç iptal edildi, bahisler iade edildi');
  };

  return (
    <div className="space-y-5 pt-2">
      <Card className="space-y-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-win/15 px-2.5 py-1 text-xs font-semibold text-win">Bahis açık</span>
          <ModelInfo match={match} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <TeamLine lineup={lineup} team="A" big />
          <TeamLine lineup={lineup} team="B" align="right" big />
        </div>
        <ProbBar probs={match.model.probs} />
      </Card>

      {canControl && (
        <div className="grid grid-cols-[1.6fr_1fr] gap-2">
          <Button variant="primary" size="lg" onClick={start}>
            <Play size={18} fill="currentColor" /> Maçı başlat
          </Button>
          <Button size="lg" onClick={cancel}>İptal</Button>
        </div>
      )}

      {bets.length > 0 && (
        <Section title="Bu maçtaki kuponların">
          <Card className="divide-y divide-line/50 py-0">
            {bets.map((b) => (
              <div key={b.id} className="flex items-center gap-2">
                <div className="flex-1">
                  <BetRow bet={{ ...b, selection: markets.flatMap((m) => m.selections).find((s) => s.id === b.selection_id) }} />
                </div>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={async () => {
                    await rpc('cancel_bet', { p_bet: b.id });
                    await refresh('me', 'matchBets', 'myBets');
                    toast('Kupon iptal edildi, coin iade edildi');
                  }}
                >
                  İptal
                </Button>
              </div>
            ))}
          </Card>
        </Section>
      )}

      <Bulletin match={match} />
    </div>
  );
}

function ModelInfo({ match }: { match: MatchRow }) {
  const [open, setOpen] = useState(false);
  const name = usePlayerName();
  const m = match.model;
  const l = initialLineup(match);
  const fmt = (x: number) => (x > 0 ? '+' : '') + x.toFixed(2).replace('.', ',');
  return (
    <>
      <button onClick={() => setOpen(true)} className="flex items-center gap-1 text-xs font-semibold text-chrome">
        <Info size={14} /> Oranlar nasıl çıktı?
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Oranlar nasıl çıktı?">
        <div className="space-y-4 text-[15px] leading-relaxed text-chrome">
          <p>
            Oranlar, onaylanmış {m.nMatches ?? 0} maçın tüm golleri, kimin hangi mevkide oynadığı ve kaç dakika oynadığı
            kullanılarak hesaplandı. Son maçlar eski maçlardan daha ağır basar.
          </p>
          {m.expectedGoals && (
            <p>
              Beklenen skor: <b className="text-chalk num">{m.expectedGoals.A.toFixed(1).replace('.', ',')} – {m.expectedGoals.B.toFixed(1).replace('.', ',')}</b>
            </p>
          )}
          {m.ratings && (
            <div className="rounded-xl bg-pitch p-3">
              <div className="mb-2 text-sm text-dim">Bu maçtaki mevkisindeki güç (yarı başına gol farkına katkı)</div>
              {(['AF', 'AK', 'BF', 'BK'] as const).map((s) => (
                <div key={s} className="flex items-center justify-between py-1">
                  <span className="flex items-center gap-2 text-chalk">
                    <TeamDot team={s[0] as Team} /> {name(l[s])} <span className="text-xs text-dim">{roleName(s[1] as 'F' | 'K')}</span>
                  </span>
                  <span className="font-semibold num text-chalk">{fmt(m.ratings![l[s]]?.[s[1] as 'F' | 'K'] ?? 0)}</span>
                </div>
              ))}
              {m.pair && (
                <div className="mt-2 border-t border-line/60 pt-2 text-sm">
                  İkili uyumu: Mavi {fmt(m.pair.A)}, Kırmızı {fmt(m.pair.B)}
                </div>
              )}
            </div>
          )}
          <p className="text-sm text-dim">
            Verisi az olan oyuncular için model temkinli davranır ve oranlar dengeye yakın kalır. Her oranda %7 kasa payı vardır;
            %95'ten olası sonuçlar bahse kapalıdır.
          </p>
        </div>
      </Sheet>
    </>
  );
}

function Bulletin({ match }: { match: MatchRow }) {
  const markets = useStore((s) => s.markets);
  const me = useStore((s) => s.me)!;
  const [slip, setSlip] = useState<{ sel: Selection; title: string } | null>(null);
  const inMatch = !!me.player_id && [match.a_f, match.a_k, match.b_f, match.b_k].includes(me.player_id);
  if (!markets.length) return <Empty title="Oranlar yükleniyor" />;
  const groups: [string, (code: string) => boolean][] = [
    ['Maç', (c) => ['ms', 'dc', 'ht', 'h2', 'htft'].includes(c)],
    ['Goller', (c) => c.startsWith('ou_') || c.startsWith('htou_') || c === 'btts'],
    ['Oyuncular', (c) => c.startsWith('pg_') || c.startsWith('pgl_') || c === 'fg'],
  ];
  return (
    <>
      {inMatch && (
        <p className="flex items-start gap-2 rounded-xl bg-felt px-3.5 py-3 text-sm text-chrome">
          <Lock size={16} className="mt-0.5 shrink-0" />
          Bu maçta oynuyorsun: kendi takımının lehine olan bahisler ve beraberlik açık.
        </p>
      )}
      {groups.map(([g, test]) => (
        <Section key={g} title={g}>
          <div className="space-y-2">
            {markets.filter((m) => test(m.code)).map((m) => (
              <Card key={m.id} className="p-3">
                <div className="mb-2 px-1 text-sm font-semibold text-chrome">{m.title}</div>
                <div className={cn('grid gap-1.5', m.selections.length === 2 ? 'grid-cols-2' : m.selections.length === 4 ? 'grid-cols-2' : 'grid-cols-3')}>
                  {m.selections.map((s) => {
                    const locked = inMatch && !s.allowed_players.includes(me.player_id!);
                    const closed = s.odds === null;
                    return (
                      <button
                        key={s.id}
                        disabled={locked || closed}
                        onClick={() => setSlip({ sel: s, title: m.title })}
                        className="flex h-14 flex-col items-center justify-center rounded-xl bg-pitch px-2 active:bg-felt-2 disabled:opacity-40"
                      >
                        <span className="line-clamp-1 text-xs text-chrome">{s.label}</span>
                        <span className="font-display text-xl font-bold text-brass num">
                          {closed ? '—' : locked ? <Lock size={15} className="mt-0.5 text-dim" /> : fmtOdds(s.odds!)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Card>
            ))}
          </div>
        </Section>
      ))}
      <BetSlip slip={slip} onClose={() => setSlip(null)} />
    </>
  );
}

function BetSlip({ slip, onClose }: { slip: { sel: Selection; title: string } | null; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const refresh = useStore((s) => s.refresh);
  const [raw, setRaw] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (slip) { setRaw(''); setErr(''); }
  }, [slip?.sel.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = Number(raw.replace(',', '.'));
  const twoDecimals = Number.isFinite(parsed) && Math.abs(parsed * 100 - Math.round(parsed * 100)) < 1e-6;
  const stake = twoDecimals ? Math.round(parsed * 100) / 100 : parsed;
  const valid = raw !== '' && twoDecimals && stake >= MIN_STAKE && stake <= me.balance;
  const add = (n: number) => setRaw(String(Math.min(me.balance, Math.round(((Number(raw.replace(',', '.')) || 0) + n) * 100) / 100)).replace('.', ','));
  const sel = slip?.sel;

  const place = async () => {
    if (!sel) return;
    setErr('');
    try {
      await rpc('place_bet', { p_selection: sel.id, p_stake: stake });
      await refresh('me', 'matchBets', 'myBets');
      thump();
      toast(`Kupon alındı: ${coin(stake)} × ${fmtOdds(sel.odds!)}`);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet open={!!slip} onClose={onClose} title={sel?.label}>
      {sel && (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-chrome">
            <span>{slip!.title}</span>
            <span className="font-display text-3xl font-bold text-brass num">{fmtOdds(sel.odds!)}</span>
          </div>
          <div className="text-sm text-dim">Modele göre olasılık {pct(sel.prob)}</div>
          <div>
            <div className="relative">
              <input
                inputMode="decimal"
                className={cn(inputCls, 'h-14 pr-24 font-display text-2xl font-bold')}
                placeholder="Tutar"
                value={raw}
                onChange={(e) => setRaw(e.target.value.replace(/[^0-9.,]/g, ''))}
                autoFocus
              />
              <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-sm text-dim">coin</span>
            </div>
            <div className="mt-2 grid grid-cols-4 gap-1.5">
              {[10, 50, 100].map((n) => (
                <button key={n} onClick={() => add(n)} className="h-10 rounded-lg bg-felt-2 text-sm font-semibold active:bg-line">+{n}</button>
              ))}
              <button onClick={() => setRaw(String(me.balance).replace('.', ','))} className="h-10 rounded-lg bg-felt-2 text-sm font-semibold active:bg-line">Tümü</button>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-pitch px-4 py-3">
            <span className="text-chrome">Kazanırsan</span>
            <Coin value={valid ? coin(payout(stake, sel.odds!)) : '—'} className="text-xl text-brass" />
          </div>
          <div className="text-sm text-dim">
            Bakiye {coin(me.balance)} · En az {MIN_STAKE} coin
          </div>
          {raw !== '' && !valid && (
            <p className="text-sm text-loss">
              {stake > me.balance ? 'Bakiyen yetmiyor.' : stake < MIN_STAKE ? `En az ${MIN_STAKE} coin yatırabilirsin.` : 'Geçerli bir tutar gir.'}
            </p>
          )}
          {err && <p className="rounded-xl bg-loss/15 px-3.5 py-3 text-sm text-loss">{err}</p>}
          <Button variant="brass" size="lg" className="w-full" disabled={!valid} onClick={place}>
            Kuponu onayla
          </Button>
        </div>
      )}
    </Sheet>
  );
}

// =====================================================================
// Canlı maç
// =====================================================================
function LiveView({ match }: { match: MatchRow }) {
  const canControl = useCanControl(match);
  const events = useStore((s) => s.events);
  const remaining = useRemaining(match);
  const setCurrent = useStore((s) => s.setCurrent);
  const refresh = useStore((s) => s.refresh);
  const ticked = useRef<string>('');
  const whistled = useRef<string>('');
  const lastBall = match.last_ball || (match.clock_running && remaining <= 0);

  // Süre bitince düdük + sunucuya bildir (bir kez)
  useEffect(() => {
    const key = `${match.id}:${match.half}`;
    if (lastBall && whistled.current !== key) {
      whistled.current = key;
      whistle();
    }
    if (canControl && match.clock_running && remaining <= 0 && ticked.current !== key) {
      ticked.current = key;
      rpc<MatchRow>('tick', { p_match: match.id }).then(setCurrent).catch(() => {});
    }
  }, [lastBall, remaining, match.id, match.half, match.clock_running, canControl, setCurrent]);

  // Kaydeden telefonun ekranı kapanmasın
  useEffect(() => {
    if (!canControl) return;
    keepAwake(true);
    const off = onResume(() => keepAwake(true));
    return () => {
      off();
      keepAwake(false);
    };
  }, [canControl]);

  const act = async (fn: string, args: Record<string, unknown>) => {
    const m = await rpc<MatchRow>(fn, { p_match: match.id, ...args });
    setCurrent(m);
    await refresh('events');
    return m;
  };

  return (
    <div className="space-y-5 pt-2">
      <Scoreboard match={match} events={events} />
      {canControl ? (
        <ControlPad match={match} events={events} remaining={remaining} lastBall={lastBall} act={act} />
      ) : (
        <p className="px-1 text-center text-sm text-dim">Skor canlı olarak güncelleniyor.</p>
      )}
      <Section title="Goller">
        <Card className="py-1">
          <EventFeed
            events={events}
            canUndo={canControl ? (e) => canUndo(match, events, e, remaining) : undefined}
            onUndo={async (e) => {
              const what = e.kind === 'goal' ? 'Bu gol silinsin mi?' : 'Mevki değişikliği geri alınsın mı?';
              if (!(await confirm(what, e.ends_half ? 'Bu gol yarıyı bitirmişti; maç son top durumuna geri döner.' : undefined, 'Geri al', true))) return;
              await act('undo_event', { p_event: e.id }).catch((x) => toast(x.message, 'error'));
            }}
          />
        </Card>
      </Section>
      <LiveBets match={match} events={events} />
      {canControl && (
        <Button
          variant="quiet"
          className="w-full"
          onClick={async () => {
            if (!(await confirm('Maç süresi dolmadan bitirilsin mi?', 'Maç kontrol ekranına geçer. Yanlışlıkla bastıysan oradan devam edebilirsin.', 'Bitir'))) return;
            await act('finish_early', {});
          }}
        >
          Maçı erken bitir
        </Button>
      )}
    </div>
  );
}

function canUndo(m: MatchRow, events: MatchEvent[], e: MatchEvent, remaining: number): boolean {
  const live = liveEvents(events);
  const latest = live[live.length - 1];
  if (e.kind === 'swap') return m.status === 'live' && latest?.id === e.id;
  if (e.ends_half) {
    if (latest?.id !== e.id) return false;
    if (e.half === 1) return m.status === 'live' && m.half === 2 && !m.clock_running && remaining === HALF_MS;
    return m.status === 'review';
  }
  return true;
}

function ControlPad({
  match, events, remaining, lastBall, act,
}: {
  match: MatchRow;
  events: MatchEvent[];
  remaining: number;
  lastBall: boolean;
  act: (fn: string, args: Record<string, unknown>) => Promise<MatchRow>;
}) {
  const name = usePlayerName();
  const lineup = lineupAfter(match, events);
  const f = deriveFacts(events);
  const [busy, setBusy] = useState<string | null>(null);
  const notStarted = !match.clock_running && remaining === HALF_MS && !lastBall;

  const goal = async (pid: string) => {
    if (busy) return;
    setBusy(pid);
    thump();
    const wasLast = lastBall;
    try {
      const m = await act('record_goal', { p_event: crypto.randomUUID(), p_player: pid, p_client_remaining_ms: Math.max(0, Math.round(remaining)) });
      if (wasLast && m.status === 'review') toast('Maç bitti');
      else if (wasLast && m.half === 2 && match.half === 1) toast('İlk yarı bitti. Taraf değiştirin, hazır olunca saati başlatın.', 'info');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setTimeout(() => setBusy(null), 350);
    }
  };

  const swap = async (t: Team) => {
    const F = name(t === 'A' ? lineup.AF : lineup.BF);
    const K = name(t === 'A' ? lineup.AK : lineup.BK);
    if (!(await confirm(`${teamName(t)} mevki değiştirsin mi?`, `${F} kaleye, ${K} forvete geçer. Her takımın maç başına tek hakkı var.`, 'Değiştir'))) return;
    await act('swap_roles', { p_event: crypto.randomUUID(), p_team: t });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {(['A', 'B'] as const).map((t) => (
          <div key={t} className="space-y-2">
            {(['F', 'K'] as const).map((r) => {
              const pid = lineup[`${t}${r}`];
              return (
                <motion.button
                  key={pid}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => goal(pid)}
                  disabled={!!busy || (!match.clock_running && !lastBall)}
                  className={cn(
                    'flex h-20 w-full flex-col items-start justify-center rounded-2xl px-4 text-left text-white transition-opacity disabled:opacity-40',
                    t === 'A' ? 'bg-blue-team' : 'bg-red-team',
                  )}
                >
                  <span className="w-full truncate text-lg font-bold">{name(pid)}</span>
                  <span className="text-sm opacity-85">
                    {roleName(r)} · {f.playerGoals[pid] ?? 0} gol
                  </span>
                </motion.button>
              );
            })}
            <button
              onClick={() => swap(t)}
              disabled={hasSwapped(events, t)}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-felt text-sm font-semibold text-chrome active:bg-felt-2 disabled:opacity-35"
            >
              <ArrowLeftRight size={15} /> {hasSwapped(events, t) ? 'Mevki değişti' : 'Mevki değiş'}
            </button>
          </div>
        ))}
      </div>
      {!lastBall && (
        <Button
          variant={match.clock_running ? 'ghost' : 'primary'}
          size="lg"
          className="w-full"
          onClick={() => act('set_clock', { p_running: !match.clock_running })}
        >
          {match.clock_running ? <><Pause size={18} /> Saati durdur</> : <><Play size={18} fill="currentColor" /> {notStarted ? `${match.half}. yarıyı başlat` : 'Saati devam ettir'}</>}
        </Button>
      )}
      <AnimatePresence>
        {lastBall && (
          <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-xl bg-brass/15 px-4 py-3 text-center text-sm font-medium text-brass">
            Süre doldu. Gelen ilk gol {match.half === 1 ? 'ilk yarıyı' : 'maçı'} bitirir.
          </motion.p>
        )}
      </AnimatePresence>
      {!match.clock_running && !lastBall && <p className="text-center text-xs text-dim">Gol girmek için saati başlatın.</p>}
    </div>
  );
}

function LiveBets({ match, events }: { match: MatchRow; events: MatchEvent[] }) {
  const me = useStore((s) => s.me)!;
  const bets = useStore((s) => s.matchBets).filter((b) => b.status !== 'cancelled');
  const markets = useStore((s) => s.markets);
  const [all, setAll] = useState(false);
  const selById = useMemo(() => new Map(markets.flatMap((m) => m.selections).map((s) => [s.id, s])), [markets]);
  const facts = deriveFacts(events);
  const list = (all ? bets : bets.filter((b) => b.user_id === me.id)).map((b) => ({ ...b, selection: selById.get(b.selection_id) }));
  if (!bets.length) return null;
  return (
    <Section
      title={all ? 'Tüm kuponlar' : 'Kuponların'}
      action={
        <button onClick={() => setAll(!all)} className="text-sm font-semibold text-chrome">
          {all ? 'Sadece benimkiler' : `Herkesinki (${bets.length})`}
        </button>
      }
    >
      <Card className="divide-y divide-line/50 py-0">
        {list.length === 0 && <p className="py-4 text-center text-sm text-dim">Bu maça kuponun yok.</p>}
        {list.map((b) => (
          <BetRow key={b.id} bet={b} showUser={all} live={b.selection && match.status === 'live' ? settleRule(b.selection.rule, facts) : null} />
        ))}
      </Card>
    </Section>
  );
}

// =====================================================================
// Maç bitti: kontrol ve onaya gönderme
// =====================================================================
function ReviewView({ match }: { match: MatchRow }) {
  const canControl = useCanControl(match);
  const events = useStore((s) => s.events);
  const setCurrent = useStore((s) => s.setCurrent);
  const refresh = useStore((s) => s.refresh);
  const live = liveEvents(events);
  const latest = live[live.length - 1];

  const act = async (fn: string, args: Record<string, unknown> = {}) => {
    const m = await rpc<MatchRow>(fn, { p_match: match.id, ...args });
    setCurrent(m);
    await refresh('current', 'events', 'queue');
  };

  return (
    <div className="space-y-5 pt-2">
      <div className="text-center">
        <span className="rounded-full bg-brass/15 px-3 py-1 text-xs font-semibold text-brass">
          {match.ended_early ? 'Maç erken bitirildi' : 'Maç bitti'}
        </span>
      </div>
      <Scoreboard match={match} events={events} />
      {canControl ? (
        <>
          <p className="px-1 text-center text-sm text-chrome">Golleri kontrol edin. Onaya gönderdikten sonra sadece admin düzeltebilir.</p>
          <Button variant="brass" size="lg" className="w-full" onClick={async () => { await act('submit_match'); toast('Onaya gönderildi'); }}>
            Onaya gönder
          </Button>
          {match.ended_early ? (
            <Button className="w-full" onClick={() => act('resume_match')}>Maça devam et</Button>
          ) : (
            latest?.ends_half && (
              <Button className="w-full" onClick={async () => {
                if (!(await confirm('Son gol geri alınsın mı?', 'Maç son top durumuna döner.', 'Geri al', true))) return;
                await act('undo_event', { p_event: latest.id });
              }}>
                Son golü geri al
              </Button>
            )
          )}
        </>
      ) : (
        <p className="px-1 text-center text-sm text-chrome">Maçı kaydeden kişi skoru kontrol ediyor.</p>
      )}
      <Section title="Goller">
        <Card className="py-1">
          <EventFeed events={events} canUndo={canControl ? (e) => !e.ends_half && e.kind === 'goal' : undefined} onUndo={async (e) => {
            if (!(await confirm('Bu gol silinsin mi?', undefined, 'Sil', true))) return;
            await act('undo_event', { p_event: e.id });
          }} />
        </Card>
      </Section>
    </div>
  );
}
