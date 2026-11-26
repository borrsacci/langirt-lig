import { ChevronRight, LogOut, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { coin, signed, when } from '../lib/format';
import { onBack } from '../lib/native';
import { useStore } from '../lib/store';
import { supabase } from '../lib/supabase';
import type { Transaction } from '../lib/types';
import { Button, Card, Coin, Section, cn, confirm } from '../ui/kit';
import { AdminScreen } from './Admin';
import { NotificationsCard } from '../ui/notifications';
import { unregisterThisDevice } from '../lib/push';

const KIND: Record<Transaction['kind'], string> = {
  signup: 'Hoş geldin bonusu',
  bet: 'Kupon',
  payout: 'Kazanç',
  refund: 'İade',
  admin: 'Admin',
  reward: 'Maç ödülü',
};

export function ProfileScreen() {
  const me = useStore((s) => s.me)!;
  const queue = useStore((s) => s.queue);
  const profiles = useStore((s) => s.profiles);
  const players = useStore((s) => s.players);
  const [admin, setAdmin] = useState(false);
  const [tx, setTx] = useState<Transaction[]>([]);

  useEffect(() => {
    supabase
      .from('transactions')
      .select('*')
      .eq('user_id', me.id)
      .order('id', { ascending: false })
      .limit(60)
      .then(({ data }) => data && setTx(data.map((t: any) => ({ ...t, amount: Number(t.amount), balance_after: Number(t.balance_after) }))));
  }, [me.id, me.balance]);

  useEffect(() => {
    if (!admin) return;
    return onBack(() => {
      setAdmin(false);
      return true;
    });
  }, [admin]);

  if (admin) return <AdminScreen onBack={() => setAdmin(false)} />;

  const pendingUsers = profiles.filter((p) => p.status === 'pending').length;
  const player = players.find((p) => p.id === me.player_id);

  return (
    <div className="space-y-5 pt-2">
      <Card className="flex items-center justify-between">
        <div>
          <div className="font-display text-2xl font-bold">{me.display_name}</div>
          <div className="text-sm text-dim">
            @{me.username}
            {player ? ` · oyuncu: ${player.name}` : ' · oyuncu profiline bağlı değil'}
          </div>
        </div>
        <Coin value={coin(me.balance)} className="font-display text-2xl text-brass" />
      </Card>

      {me.is_admin && (
        <button onClick={() => setAdmin(true)} className="flex w-full items-center gap-3 rounded-2xl bg-brass/15 px-4 py-4 text-left active:bg-brass/25">
          <ShieldCheck className="text-brass" />
          <div className="flex-1">
            <div className="font-semibold text-brass">Admin paneli</div>
            <div className="text-sm text-chrome">
              {queue.length} maç ve {pendingUsers} kullanıcı onay bekliyor
            </div>
          </div>
          <ChevronRight className="text-chrome" />
        </button>
      )}

      <NotificationsCard />

      <Section title="Hesap hareketleri">
        <Card className="divide-y divide-line/50 py-0">
          {tx.length === 0 && <p className="py-4 text-center text-sm text-dim">Henüz hareket yok.</p>}
          {tx.map((t) => (
            <div key={t.id} className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">{t.note || KIND[t.kind]}</div>
                <div className="text-xs text-dim">{when(t.created_at)}</div>
              </div>
              <div className="text-right num">
                <div className={cn('font-semibold', t.amount > 0 ? 'text-win' : 'text-chalk')}>{signed(t.amount)}</div>
                <div className="text-xs text-dim">{coin(t.balance_after)}</div>
              </div>
            </div>
          ))}
        </Card>
      </Section>

      <Button
        className="w-full"
        onClick={async () => {
          if (await confirm('Çıkış yapılsın mı?', undefined, 'Çıkış yap')) {
            await unregisterThisDevice();
            await supabase.auth.signOut();
          }
        }}
      >
        <LogOut size={18} /> Çıkış yap
      </Button>
      <p className="text-center text-xs text-dim">Sürüm {__APP_VERSION__}</p>
    </div>
  );
}
