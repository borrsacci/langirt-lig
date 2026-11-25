import { BarChart3, CircleDot, Ticket, Trophy, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { onBack, onResume, tap } from './lib/native';
import { useStore } from './lib/store';
import { isConfigured, supabase } from './lib/supabase';
import { AuthScreen, NotConfigured, PendingScreen } from './screens/Auth';
import { CouponsScreen } from './screens/Coupons';
import { MatchScreen } from './screens/Match';
import { ProfileScreen } from './screens/Profile';
import { RanksScreen } from './screens/Ranks';
import { StatsScreen } from './screens/Stats';
import { Coin, ConfirmHost, Spinner, Toasts, cn } from './ui/kit';
import { coin } from './lib/format';
import { checkUpdate, type UpdateInfo } from './lib/update';

type Tab = 'match' | 'coupons' | 'stats' | 'ranks' | 'profile';

export default function App() {
  const { booted, uid, me, start } = useStore();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setAuthChecked(true);
      start(data.session?.user.id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((ev, session) => {
      if (ev === 'SIGNED_IN' || ev === 'SIGNED_OUT') {
        const id = session?.user.id ?? null;
        if (id !== useStore.getState().uid) start(id);
      }
    });
    const off = onResume(() => {
      const s = useStore.getState();
      s.syncClock();
      s.refresh();
    });
    return () => {
      sub.subscription.unsubscribe();
      off();
    };
  }, [start]);

  if (!isConfigured) return <NotConfigured />;
  if (!authChecked || !booted) return <Splash />;
  return (
    <>
      {!uid || !me ? <AuthScreen /> : me.status !== 'active' ? <PendingScreen /> : <Shell />}
      <Toasts />
      <ConfirmHost />
    </>
  );
}

function Splash() {
  return (
    <div className="felt-bg flex h-full items-center justify-center">
      <Spinner className="size-6 text-brass" />
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('match');
  const me = useStore((s) => s.me)!;
  const current = useStore((s) => s.current);
  const online = useStore((s) => s.online);
  const queue = useStore((s) => s.queue);
  const profiles = useStore((s) => s.profiles);
  const adminBadge = me.is_admin ? queue.length + profiles.filter((p) => p.status === 'pending').length : 0;
  const openBets = useStore((s) => s.myBets.filter((b) => b.status === 'open').length);

  useEffect(
    () =>
      onBack(() => {
        if (tab !== 'match') {
          setTab('match');
          return true;
        }
        return false;
      }),
    [tab],
  );

  const go = (t: Tab) => {
    tap();
    setTab(t);
    document.getElementById('main')?.scrollTo({ top: 0 });
  };

  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    checkUpdate().then(setUpdate);
    return onResume(() => checkUpdate().then(setUpdate));
  }, []);

  const live = current?.status === 'live';
  const items: [Tab, string, typeof CircleDot, number | boolean][] = [
    ['match', 'Maç', CircleDot, live || current?.status === 'open'],
    ['coupons', 'Kuponlar', Ticket, openBets],
    ['stats', 'İstatistik', BarChart3, false],
    ['ranks', 'Sıralama', Trophy, false],
    ['profile', 'Profil', UserRound, adminBadge],
  ];

  return (
    <div className="felt-bg flex h-full flex-col">
      <header className="pt-safe shrink-0">
        <div className="mx-auto flex h-14 max-w-lg items-center justify-between px-4">
          <div className="flex items-center gap-2.5">
            <TableMark />
            <span className="font-display text-[22px] font-bold tracking-tight">Langırt Ligi</span>
          </div>
          <button onClick={() => go('profile')} className="rounded-full bg-felt px-3 py-1.5">
            <Coin value={coin(me.balance)} className="text-brass" />
          </button>
        </div>
        {update && (
          <a href={update.url} className="block bg-brass px-4 py-2 text-center text-sm font-semibold text-pitch">
            Yeni sürüm hazır. Dokunup indirin ve kurun.
          </a>
        )}
        {!online && (
          <div className="bg-loss/15 px-4 py-1.5 text-center text-xs font-medium text-loss">Bağlantı koptu, yeniden bağlanıyor…</div>
        )}
      </header>

      <main id="main" className="no-scrollbar mx-auto w-full max-w-lg flex-1 overflow-y-auto px-4 pb-6">
        {tab === 'match' && <MatchScreen />}
        {tab === 'coupons' && <CouponsScreen />}
        {tab === 'stats' && <StatsScreen />}
        {tab === 'ranks' && <RanksScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </main>

      <nav className="pb-safe shrink-0 border-t border-line/60 bg-pitch/95">
        <div className="mx-auto flex max-w-lg">
          {items.map(([k, label, Icon, badge]) => (
            <button key={k} onClick={() => go(k)} className={cn('relative flex h-16 flex-1 flex-col items-center justify-center gap-1', tab === k ? 'text-chalk' : 'text-dim')}>
              <Icon size={22} strokeWidth={tab === k ? 2.4 : 1.8} />
              <span className="text-[11px] font-semibold">{label}</span>
              {badge === true && <span className={cn('absolute right-[calc(50%-18px)] top-3 size-2 rounded-full', live ? 'animate-pulse bg-loss' : 'bg-win')} />}
              {typeof badge === 'number' && badge > 0 && (
                <span className="absolute right-[calc(50%-22px)] top-2 min-w-[18px] rounded-full bg-brass px-1 text-[11px] font-bold leading-[18px] text-pitch">{badge}</span>
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Logo: yukarıdan bakılmış langırt masası (iki kale, orta çizgi) */
function TableMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <rect x="2" y="4" width="22" height="18" rx="3" fill="#164433" stroke="#a9bab3" strokeWidth="1.5" />
      <line x1="13" y1="4" x2="13" y2="22" stroke="#a9bab3" strokeWidth="1.2" />
      <rect x="0.5" y="10" width="2" height="6" rx="1" fill="#3b82f6" />
      <rect x="23.5" y="10" width="2" height="6" rx="1" fill="#ef4444" />
      <circle cx="13" cy="13" r="2.2" fill="#f2c14e" />
    </svg>
  );
}
