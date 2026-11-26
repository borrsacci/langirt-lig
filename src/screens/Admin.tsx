import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import { invoke, rpc } from '../lib/api';
import { coin, when } from '../lib/format';
import { useStore, usePlayerName } from '../lib/store';
import type { Player, Profile } from '../lib/types';
import { Button, Card, Coin, Empty, Field, Section, Segmented, Sheet, cn, confirm, inputCls, toast } from '../ui/kit';
import { MatchDetail } from './MatchDetail';

export function AdminScreen({ onBack }: { onBack: () => void }) {
  const queue = useStore((s) => s.queue);
  const profiles = useStore((s) => s.profiles);
  const [tab, setTab] = useState<'matches' | 'users' | 'players'>(queue.length || !profiles.some((p) => p.status === 'pending') ? 'matches' : 'users');
  const pending = profiles.filter((p) => p.status === 'pending').length;
  return (
    <div className="space-y-4 pt-2">
      <button onClick={onBack} className="flex items-center gap-1.5 text-sm font-semibold text-chrome">
        <ArrowLeft size={16} /> Profil
      </button>
      <h1 className="font-display text-3xl font-bold">Admin paneli</h1>
      <Segmented
        value={tab}
        onChange={setTab}
        items={[
          ['matches', `Maç onayı${queue.length ? ` (${queue.length})` : ''}`],
          ['users', `Kullanıcılar${pending ? ` (${pending})` : ''}`],
          ['players', 'Oyuncular'],
        ]}
      />
      <House />
      {tab === 'matches' && <MatchQueue />}
      {tab === 'users' && <Users />}
      {tab === 'players' && <Players />}
    </div>
  );
}

function House() {
  const [h, setH] = useState<Record<string, number> | null>(null);
  const balance = useStore((s) => s.me?.balance);
  const queue = useStore((s) => s.queue.length);
  useEffect(() => {
    rpc<Record<string, number>>('admin_house_stats').then(setH).catch(() => {});
  }, [balance, queue]);
  if (!h) return null;
  const profit = Number(h.staked) - Number(h.paid);
  return (
    <Card className="grid grid-cols-3 gap-2 text-center">
      <div>
        <div className="font-display text-xl font-bold text-brass num">{coin(h.open_stake)}</div>
        <div className="text-xs text-dim">Açık kuponlar</div>
      </div>
      <div>
        <div className={cn('font-display text-xl font-bold num', profit >= 0 ? 'text-win' : 'text-loss')}>{coin(profit)}</div>
        <div className="text-xs text-dim">Kasa kârı</div>
      </div>
      <div>
        <div className="font-display text-xl font-bold num">{coin(h.coins_in_play)}</div>
        <div className="text-xs text-dim">Oyuncu coinleri</div>
      </div>
    </Card>
  );
}

function MatchQueue() {
  const queue = useStore((s) => s.queue);
  const name = usePlayerName();
  const [sel, setSel] = useState<string | null>(null);
  if (!queue.length) return <Empty title="Onay bekleyen maç yok">Biten maçlar onaya gönderildiğinde burada görünür.</Empty>;
  return (
    <>
      <div className="space-y-2">
        {queue.map((m) => (
          <button key={m.id} onClick={() => setSel(m.id)} className="w-full rounded-2xl bg-felt p-4 text-left active:bg-felt-2">
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className={cn('rounded-full px-2 py-0.5 font-semibold', m.status === 'pending' ? 'bg-brass/15 text-brass' : 'bg-felt-2 text-chrome')}>
                {m.status === 'pending' ? 'Onaya gönderildi' : 'Kaydeden kontrol ediyor'}
              </span>
              <span className="text-dim">{when(m.created_at)}</span>
            </div>
            <div className="font-semibold">
              {name(m.a_f)} & {name(m.a_k)} – {name(m.b_f)} & {name(m.b_k)}
            </div>
          </button>
        ))}
      </div>
      <MatchDetail matchId={sel} onClose={() => setSel(null)} admin />
    </>
  );
}

function Users() {
  const profiles = useStore((s) => s.profiles);
  const players = useStore((s) => s.players);
  const refresh = useStore((s) => s.refresh);
  const [sel, setSel] = useState<Profile | null>(null);
  const linked = new Set(profiles.map((p) => p.player_id).filter(Boolean));
  const pending = profiles.filter((p) => p.status === 'pending');
  const others = profiles.filter((p) => p.status !== 'pending');
  const playerName = (id: string | null) => players.find((p) => p.id === id)?.name;
  const [access, reloadAccess] = useAccess();

  return (
    <div className="space-y-5">
      <GrantAll />
      {pending.length > 0 && (
        <Section title="Onay bekleyenler">
          {pending.map((p) => (
            <PendingUser
              key={p.id}
              p={p}
              free={players.filter((x) => !linked.has(x.id))}
              onDone={() => {
                refresh('profiles', 'players', 'leaderboard');
                reloadAccess();
              }}
            />
          ))}
        </Section>
      )}
      <Section title="Hesaplar">
        <div className="space-y-1.5">
          {others.map((p) => (
            <button key={p.id} onClick={() => setSel(p)} className="flex w-full items-center gap-3 rounded-xl bg-felt px-4 py-3 text-left active:bg-felt-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {p.display_name} {p.is_admin && <span className="text-xs text-brass">admin</span>}
                  {p.status === 'disabled' && <span className="text-xs text-loss"> kapalı</span>}
                </div>
                <div className="truncate text-xs text-dim">@{p.username} · {playerName(p.player_id) ?? 'oyuncu bağlı değil'}</div>
                <AccessBadges a={access[p.id]} />
              </div>
              <Coin value={coin(p.balance)} className="text-brass" />
            </button>
          ))}
        </div>
      </Section>
      <UserSheet p={sel} onClose={() => setSel(null)} free={players.filter((x) => !linked.has(x.id))} access={sel ? access[sel.id] : undefined} onAccess={reloadAccess} />
    </div>
  );
}

function GrantAll() {
  const refresh = useStore((s) => s.refresh);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const amt = Number(amount.replace(',', '.'));
  return (
    <Section title="Herkese coin ver">
      <Card className="space-y-2">
        <p className="text-sm text-dim">Tek bir hesaba coin eklemek veya düşmek için aşağıdan kişiye dokunun.</p>
        <div className="grid grid-cols-[1fr_1.4fr] gap-2">
          <input className={inputCls} inputMode="decimal" placeholder="Tutar" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} />
          <input className={inputCls} placeholder="Açıklama (ör. Ay sonu)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button
          className="w-full"
          variant="brass"
          disabled={!(amt > 0)}
          onClick={async () => {
            if (!(await confirm(`Herkese ${coin(amt)} coin verilsin mi?`, 'Tüm aktif hesaplara eklenir.', 'Ver'))) return;
            const n = await rpc<number>('admin_grant_all', { p_amount: amt, p_note: note });
            setAmount('');
            setNote('');
            await refresh('profiles', 'leaderboard', 'me');
            toast(`${n} hesaba ${coin(amt)} coin eklendi`);
          }}
        >
          Herkese ver
        </Button>
      </Card>
    </Section>
  );
}

function PendingUser({ p, free, onDone }: { p: Profile; free: Player[]; onDone: () => void }) {
  const match = free.find((x) => x.name.toLocaleLowerCase('tr') === p.display_name.toLocaleLowerCase('tr'));
  const [player, setPlayer] = useState<string>(match?.id ?? 'new');
  const [acc, setAcc] = useState({ live: true, history: true, notify: true });
  const nameTaken = player === 'new' && !match && useStore.getState().players.some((x) => x.name.toLocaleLowerCase('tr') === p.display_name.toLocaleLowerCase('tr'));
  return (
    <Card className="space-y-3">
      <div>
        <div className="font-semibold">{p.display_name}</div>
        <div className="text-xs text-dim">@{p.username} · {when(p.created_at)}</div>
      </div>
      <Field label="Oyuncu profili" hint={nameTaken ? 'Bu isimde bir oyuncu başka bir hesaba bağlı; listeden seçin veya önce oyuncuyu yeniden adlandırın.' : 'Maç istatistikleri bu oyuncuya işlenir.'}>
        <select className={inputCls} value={player} onChange={(e) => setPlayer(e.target.value)}>
          {!match && <option value="new">Yeni oyuncu: {p.display_name}</option>}
          {free.map((x) => (
            <option key={x.id} value={x.id}>{x.name}{x.active ? '' : ' (pasif)'}</option>
          ))}
        </select>
      </Field>
      <div className="space-y-1.5">
        <span className="text-sm font-medium text-chrome">Erişim</span>
        <AccessChecks {...acc} set={setAcc} />
      </div>
      <div className="grid grid-cols-[1fr_1.6fr] gap-2">
        <Button
          variant="danger"
          onClick={async () => {
            if (!(await confirm(`${p.display_name} reddedilsin mi?`, 'Hesap kapatılır, giriş yapamaz.', 'Reddet', true))) return;
            await rpc('admin_set_user_status', { p_user: p.id, p_status: 'disabled' });
            onDone();
          }}
        >
          Reddet
        </Button>
        <Button
          variant="brass"
          disabled={nameTaken}
          onClick={async () => {
            await rpc('admin_approve_user', { p_user: p.id, p_player: player === 'new' ? null : player });
            const vis = toVis(acc.live, acc.history);
            if (vis !== 'full' || !acc.notify) await rpc('admin_set_access', { p_user: p.id, p_visibility: vis, p_notify: acc.live && acc.notify });
            toast(`${p.display_name} onaylandı, 1000 coin yüklendi`);
            onDone();
          }}
        >
          Onayla
        </Button>
      </div>
    </Card>
  );
}

function UserSheet({ p, onClose, free, access, onAccess }: { p: Profile | null; onClose: () => void; free: Player[]; access?: Access; onAccess: () => void }) {
  const refresh = useStore((s) => s.refresh);
  const me = useStore((s) => s.me)!;
  const players = useStore((s) => s.players);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [pw, setPw] = useState('');
  const [link, setLink] = useState('');
  const done = async (msg: string) => {
    toast(msg);
    await refresh('profiles', 'leaderboard', 'me');
    onClose();
  };
  const amt = Number(amount.replace(',', '.'));
  return (
    <Sheet open={!!p} onClose={onClose} title={p?.display_name}>
      {p && (
        <div className="space-y-6">
          <div className="flex justify-between text-chrome">
            <span>@{p.username}</span>
            <Coin value={coin(p.balance)} className="text-brass" />
          </div>
          {!p.is_admin && <AccessEditor userId={p.id} access={access} onSaved={onAccess} />}
          <Section title="Coin ekle veya düş">
            <div className="grid grid-cols-[1fr_1.4fr] gap-2">
              <input className={inputCls} inputMode="decimal" placeholder="ör. 500 veya -100" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,-]/g, ''))} />
              <input className={inputCls} placeholder="Açıklama" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <Button
              className="w-full"
              disabled={!amt || !Number.isFinite(amt)}
              onClick={async () => {
                await rpc('admin_adjust_balance', { p_user: p.id, p_amount: amt, p_note: note });
                await done('Bakiye güncellendi');
              }}
            >
              Bakiyeyi güncelle
            </Button>
          </Section>
          <Section title="Oyuncu profili">
            <select className={inputCls} value={link || p.player_id || ''} onChange={(e) => setLink(e.target.value)}>
              {p.player_id && <option value={p.player_id}>{players.find((x) => x.id === p.player_id)?.name}</option>}
              {!p.player_id && <option value="">Seçin</option>}
              {free.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
            <Button
              className="w-full"
              disabled={!link || link === p.player_id}
              onClick={async () => {
                await rpc('admin_link_player', { p_user: p.id, p_player: link });
                await done('Oyuncu bağlandı');
              }}
            >
              Bağla
            </Button>
          </Section>
          <Section title="Şifre sıfırla">
            <input className={inputCls} placeholder="Yeni şifre (en az 6 karakter)" value={pw} onChange={(e) => setPw(e.target.value)} />
            <Button
              className="w-full"
              disabled={pw.length < 6}
              onClick={async () => {
                await invoke('admin-users', { action: 'reset_password', user_id: p.id, password: pw });
                setPw('');
                toast('Şifre değiştirildi. Yeni şifreyi kullanıcıya iletin.');
              }}
            >
              Şifreyi değiştir
            </Button>
          </Section>
          {p.id !== me.id && (
            <Button
              variant={p.status === 'disabled' ? 'primary' : 'danger'}
              className="w-full"
              onClick={async () => {
                const off = p.status !== 'disabled';
                if (off && !(await confirm(`${p.display_name} kapatılsın mı?`, 'Giriş yapamaz ve bahis oynayamaz. Bakiyesi korunur.', 'Hesabı kapat', true))) return;
                await rpc('admin_set_user_status', { p_user: p.id, p_status: off ? 'disabled' : 'active' });
                await done(off ? 'Hesap kapatıldı' : 'Hesap açıldı');
              }}
            >
              {p.status === 'disabled' ? 'Hesabı yeniden aç' : 'Hesabı kapat'}
            </Button>
          )}
        </div>
      )}
    </Sheet>
  );
}

function Players() {
  const players = useStore((s) => s.players);
  const refresh = useStore((s) => s.refresh);
  const history = useStore((s) => s.history);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<Player | null>(null);
  const [editName, setEditName] = useState('');
  const played = (id: string) => history.filter((m) => [m.a_f, m.a_k, m.b_f, m.b_k].includes(id)).length;
  return (
    <div className="space-y-4">
      <p className="px-1 text-sm text-dim">
        Uygulaması olmayanlar için de oyuncu ekleyebilirsiniz. Hesap açan kişiler onaylanırken bir oyuncuya bağlanır.
      </p>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input className={inputCls} placeholder="Oyuncu adı" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
        <Button
          variant="primary"
          disabled={name.trim().length < 2}
          onClick={async () => {
            await rpc('admin_add_player', { p_name: name.trim() });
            setName('');
            await refresh('players');
            toast('Oyuncu eklendi');
          }}
        >
          Ekle
        </Button>
      </div>
      <div className="space-y-1.5">
        {players.map((p) => (
          <button
            key={p.id}
            onClick={() => { setEdit(p); setEditName(p.name); }}
            className={cn('flex w-full items-center justify-between rounded-xl bg-felt px-4 py-3 text-left active:bg-felt-2', !p.active && 'opacity-50')}
          >
            <span className="font-semibold">{p.name}</span>
            <span className="text-sm text-dim">{p.active ? `${played(p.id)} maç` : 'pasif'}</span>
          </button>
        ))}
      </div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.name}>
        {edit && (
          <div className="space-y-3">
            <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={24} />
            <Button
              variant="primary"
              className="w-full"
              disabled={editName.trim().length < 2 || editName.trim() === edit.name}
              onClick={async () => {
                await rpc('admin_update_player', { p_player: edit.id, p_name: editName.trim(), p_active: edit.active });
                await refresh('players');
                setEdit(null);
              }}
            >
              Adı kaydet
            </Button>
            <Button
              className="w-full"
              onClick={async () => {
                await rpc('admin_update_player', { p_player: edit.id, p_name: edit.name, p_active: !edit.active });
                await refresh('players');
                setEdit(null);
                toast(edit.active ? 'Oyuncu pasif yapıldı; geçmiş istatistikleri korunur' : 'Oyuncu aktif');
              }}
            >
              {edit.active ? 'Pasif yap (kura listesinden çıkar)' : 'Aktif yap'}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}


// ---------------------------------------------------------------- Erişim (sadece admin görür)
type Visibility = 'full' | 'no_live' | 'none';
interface Access {
  visibility: Visibility;
  notify: boolean;
}
/** Tik kutuları ↔ görünürlük seviyesi */
function toVis(live: boolean, history: boolean): Visibility {
  return history ? (live ? 'full' : 'no_live') : 'none';
}

function Check({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('flex items-center gap-3 rounded-xl bg-pitch px-4 py-3', disabled && 'opacity-45')}>
      <div className="min-w-0 flex-1">
        <div className="text-[15px]">{label}</div>
        {hint && <div className="text-xs text-dim">{hint}</div>}
      </div>
      <input type="checkbox" className="size-5 shrink-0 accent-[#f2c14e]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Erişim tik kutuları (onay kartında ve kullanıcı penceresinde aynı) */
function AccessChecks({ live, history, notify, set }: { live: boolean; history: boolean; notify: boolean; set: (v: { live: boolean; history: boolean; notify: boolean }) => void }) {
  return (
    <div className="space-y-1.5">
      <Check
        label="Canlı maçları görsün"
        hint="Açık bahisler, oynanan ve onay bekleyen maçlar"
        checked={live}
        onChange={(v) => set({ live: v, history: v ? true : history, notify: v ? notify : false })}
      />
      <Check
        label="Geçmiş maçları ve istatistikleri görsün"
        hint="Onaylanmış sonuçlar, istatistikler, kuponlar, sıralama"
        checked={history}
        onChange={(v) => set({ live: v ? live : false, history: v, notify: v && live ? notify : false })}
      />
      <Check
        label="Bildirim gönder"
        hint={live ? 'Bahisler açılınca ve maç sonuçlanınca' : 'Canlı maçları görmeyen kişiye bildirim gitmez'}
        checked={live && notify}
        disabled={!live}
        onChange={(v) => set({ live, history, notify: v })}
      />
    </div>
  );
}

function useAccess(): [Record<string, Access>, () => void] {
  const [a, setA] = useState<Record<string, Access>>({});
  const load = () => {
    rpc<{ user_id: string; visibility: Visibility; notify: boolean }[]>('admin_list_access')
      .then((rows) => setA(Object.fromEntries(rows.map((r) => [r.user_id, { visibility: r.visibility, notify: r.notify }]))))
      .catch(() => {});
  };
  useEffect(load, []);
  return [a, load];
}

function AccessBadges({ a }: { a?: Access }) {
  if (!a || (a.visibility === 'full' && a.notify)) return null;
  return (
    <div className="mt-1 flex gap-1.5">
      {a.visibility === 'none' && <span className="rounded bg-loss/15 px-1.5 py-0.5 text-[11px] font-semibold text-loss">Maçları görmez</span>}
      {a.visibility === 'no_live' && <span className="rounded bg-brass/15 px-1.5 py-0.5 text-[11px] font-semibold text-brass">Canlıyı görmez</span>}
      {a.visibility === 'full' && !a.notify && <span className="rounded bg-felt-2 px-1.5 py-0.5 text-[11px] font-semibold text-chrome">Bildirim kapalı</span>}
    </div>
  );
}

function AccessEditor({ userId, access, onSaved }: { userId: string; access?: Access; onSaved: () => void }) {
  const init = () => {
    const v = access?.visibility ?? 'full';
    return { live: v === 'full', history: v !== 'none', notify: v === 'full' && (access?.notify ?? true) };
  };
  const [st, setSt] = useState(init);
  useEffect(() => setSt(init()), [access?.visibility, access?.notify, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const orig = init();
  const changed = st.live !== orig.live || st.history !== orig.history || st.notify !== orig.notify;
  return (
    <Section title="Erişim">
      <p className="text-xs text-dim">Bu ayarları sadece siz görürsünüz; kişiye hiçbir şey söylenmez.</p>
      <AccessChecks {...st} set={setSt} />
      <Button
        className="w-full"
        variant="primary"
        disabled={!changed}
        onClick={async () => {
          await rpc('admin_set_access', { p_user: userId, p_visibility: toVis(st.live, st.history), p_notify: st.live && st.notify });
          onSaved();
          toast('Erişim kaydedildi');
        }}
      >
        Erişimi kaydet
      </Button>
    </Section>
  );
}
