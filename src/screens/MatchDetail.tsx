import { useCallback, useEffect, useState } from 'react';
import { deriveFacts, lineupAfter } from '../../supabase/functions/_shared/game.ts';
import { invoke, rpc } from '../lib/api';
import { when } from '../lib/format';
import { supabase } from '../lib/supabase';
import { useStore, usePlayerName } from '../lib/store';
import type { Bet, Market, MatchEvent, MatchRow, Selection } from '../lib/types';
import { Button, Card, Section, Sheet, Spinner, cn, confirm, toast } from '../ui/kit';
import { BetRow, EventFeed, ProbBar, Scoreboard, roleName } from '../ui/match';

const STATUS: Record<string, string> = {
  open: 'Bahis açık', live: 'Oynanıyor', review: 'Kayıt kontrol ediliyor', pending: 'Onay bekliyor',
  approved: 'Onaylandı', rejected: 'Reddedildi', cancelled: 'İptal edildi',
};

interface Detail {
  match: MatchRow;
  events: MatchEvent[];
  selections: (Selection & { market: Market })[];
  bets: Bet[];
}

export function MatchDetail({ matchId, onClose, admin }: { matchId: string | null; onClose: () => void; admin?: boolean }) {
  const [d, setD] = useState<Detail | null>(null);
  const name = usePlayerName();
  const refreshStore = useStore((s) => s.refresh);

  const load = useCallback(async () => {
    if (!matchId) return;
    const [m, e, s, b] = await Promise.all([
      supabase.from('matches').select('*').eq('id', matchId).single(),
      supabase.from('match_events').select('*').eq('match_id', matchId).order('seq'),
      supabase.from('selections').select('*, market:markets(*)').eq('match_id', matchId),
      supabase.from('bets').select('*').eq('match_id', matchId).order('created_at'),
    ]);
    if (m.data)
      setD({
        match: m.data as MatchRow,
        events: (e.data ?? []).map((x) => ({ ...x, seq: Number(x.seq) })) as MatchEvent[],
        selections: (s.data ?? []).map((x: any) => ({ ...x, odds: x.odds === null ? null : Number(x.odds) })),
        bets: (b.data ?? []).map((x: any) => ({ ...x, stake: Number(x.stake), odds: Number(x.odds), payout: Number(x.payout) })),
      });
  }, [matchId]);

  useEffect(() => {
    setD(null);
    load();
  }, [load]);

  const m = d?.match;
  const editable = admin && m && (m.status === 'review' || m.status === 'pending');
  const f = d ? deriveFacts(d.events) : null;

  const decide = async (kind: 'approve' | 'void' | 'reject') => {
    if (!m) return;
    const texts = {
      approve: ['Maç onaylansın mı?', 'Skor istatistiklere işlenir ve tüm kuponlar sonuçlandırılır. Bu işlem geri alınamaz.', 'Onayla'],
      void: ['Onayla, bahisleri iade et?', 'Maç istatistiklere işlenir ama bu maça yapılan tüm bahisler iade edilir (ör. maç yarım kaldıysa).', 'Onayla ve iade et'],
      reject: ['Maç reddedilsin mi?', 'Maç istatistiklere girmez, tüm bahisler iade edilir.', 'Reddet'],
    }[kind];
    if (!(await confirm(texts[0], texts[1], texts[2], kind === 'reject'))) return;
    if (kind === 'reject') await rpc('reject_match', { p_match: m.id, p_note: null });
    else await rpc('approve_match', { p_match: m.id, p_void_bets: kind === 'void', p_note: null });
    toast(kind === 'reject' ? 'Maç reddedildi' : 'Maç onaylandı');
    // herkese sonuç bildirimi (hata olsa da onay geçerli)
    if (kind !== 'reject') invoke('notify', { action: 'settled', match_id: m.id }).catch(() => {});
    await refreshStore('queue', 'history', 'leaderboard', 'me', 'myBets', 'current');
    onClose();
  };

  const addGoal = async (half: 1 | 2, pid: string) => {
    if (!m) return;
    await rpc('admin_add_goal', { p_match: m.id, p_event: crypto.randomUUID(), p_half: half, p_player: pid });
    await load();
  };

  return (
    <Sheet open={!!matchId} onClose={onClose} title={m ? STATUS[m.status] : 'Maç'}>
      {!d || !m || !f ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : (
        <div className="space-y-5">
          <div className="text-sm text-dim">
            {when(m.created_at)}
            {m.ended_early && ' · erken bitirildi'}
            {m.bets_voided && m.status === 'approved' && ' · bahisler iade edildi'}
          </div>
          <Scoreboard match={m} events={d.events} />
          <div className="text-center text-sm text-chrome num">İlk yarı {f.htA}-{f.htB} · İkinci yarı {f.goalsA - f.htA}-{f.goalsB - f.htB}</div>
          {m.model.probs && (
            <Card className="space-y-2 bg-pitch">
              <div className="text-sm text-dim">Maç öncesi model tahmini</div>
              <ProbBar probs={m.model.probs} />
            </Card>
          )}
          <Section title="Goller">
            <Card className="bg-pitch py-1">
              <EventFeed
                events={d.events}
                canUndo={editable ? (e) => e.kind === 'goal' : undefined}
                onUndo={async (e) => {
                  await rpc('admin_delete_goal', { p_match: m.id, p_event: e.id });
                  await load();
                }}
              />
            </Card>
          </Section>
          {editable && (
            <Section title="Gol ekle">
              <div className="space-y-2">
                {([1, 2] as const).map((half) => {
                  const l = lineupAfter(m, d.events.filter((e) => e.half <= half));
                  return (
                    <div key={half}>
                      <div className="mb-1 text-sm text-chrome">{half}. yarı</div>
                      <div className="grid grid-cols-4 gap-1.5">
                        {(['AF', 'AK', 'BF', 'BK'] as const).map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant={s[0] === 'A' ? 'blue' : 'red'}
                            className="h-auto flex-col gap-0 py-1.5"
                            onClick={() => addGoal(half, l[s])}
                          >
                            <span className="w-full truncate">{name(l[s])}</span>
                            <span className="text-[11px] opacity-80">{roleName(s[1] as 'F' | 'K')}</span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Section>
          )}
          {editable && (
            <div className="space-y-2">
              <Button variant="brass" size="lg" className="w-full" onClick={() => decide('approve')}>Onayla</Button>
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => decide('void')}>Onayla, bahisleri iade et</Button>
                <Button variant="danger" onClick={() => decide('reject')}>Reddet</Button>
              </div>
            </div>
          )}
          {d.bets.length > 0 && (
            <Section title={`Kuponlar (${d.bets.filter((b) => b.status !== 'cancelled').length})`}>
              <Card className={cn('divide-y divide-line/50 bg-pitch py-0')}>
                {d.bets
                  .filter((b) => b.status !== 'cancelled')
                  .map((b) => (
                    <BetRow key={b.id} bet={{ ...b, selection: d.selections.find((s) => s.id === b.selection_id) }} showUser />
                  ))}
              </Card>
            </Section>
          )}
        </div>
      )}
    </Sheet>
  );
}
