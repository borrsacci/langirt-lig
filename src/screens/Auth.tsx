import { useState } from 'react';
import { errText, rpc } from '../lib/api';
import { useStore } from '../lib/store';
import { emailFor, supabase } from '../lib/supabase';
import { Button, Field, Segmented, inputCls, toast } from '../ui/kit';

const USER_RE = /^[a-z0-9_.]{3,20}$/;

/** Türkçe karakterleri sadeleştirip kullanıcı adına çevirir */
export function toUsername(s: string): string {
  const map: Record<string, string> = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', Ç: 'c', Ğ: 'g', Ö: 'o', Ş: 's', Ü: 'u' };
  return s.replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => map[c]).toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_.]/g, '').slice(0, 20);
}

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');

  const login = async () => {
    setError('');
    const u = toUsername(username);
    const { error } = await supabase.auth.signInWithPassword({ email: emailFor(u), password: pw });
    if (error) setError(/Invalid login/i.test(error.message) ? 'Kullanıcı adı veya şifre hatalı.' : errText(error));
  };

  const register = async () => {
    setError('');
    const u = toUsername(username);
    if (!USER_RE.test(u)) return setError('Kullanıcı adı 3-20 karakter olmalı: harf, rakam, nokta veya alt çizgi.');
    if (name.trim().length < 2 || name.trim().length > 24) return setError('Adınız 2-24 karakter olmalı.');
    if (pw.length < 6) return setError('Şifre en az 6 karakter olmalı.');
    if (pw !== pw2) return setError('Şifreler aynı değil.');
    const free = await rpc<boolean>('username_available', { p_username: u }).catch(() => true);
    if (!free) return setError('Bu kullanıcı adı alınmış.');
    const { data, error } = await supabase.auth.signUp({
      email: emailFor(u),
      password: pw,
      options: { data: { username: u, display_name: name.trim() } },
    });
    if (error) return setError(/registered/i.test(error.message) ? 'Bu kullanıcı adı alınmış.' : errText(error));
    if (!data.session) {
      setError('Hesap açıldı ama oturum başlamadı. Supabase ayarlarında "Confirm email" kapalı olmalı.');
      return;
    }
    toast('Hesabınız oluşturuldu');
  };

  return (
    <div className="felt-bg flex h-full flex-col overflow-y-auto px-6 pt-safe">
      <div className="mx-auto w-full max-w-sm flex-1 py-10">
        <Hero />
        <Segmented
          className="mb-6"
          value={mode}
          onChange={(m) => { setMode(m); setError(''); }}
          items={[['login', 'Giriş yap'], ['register', 'Hesap aç']]}
        />
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Field label="Kullanıcı adı" hint={mode === 'register' ? 'Giriş yaparken bunu kullanacaksınız.' : undefined}>
            <input
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="username"
              placeholder="ör. okan"
            />
          </Field>
          {mode === 'register' && (
            <Field label="Adınız" hint="Maçlarda ve sıralamalarda bu görünür.">
              <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. Okan" maxLength={24} />
            </Field>
          )}
          <Field label="Şifre">
            <input className={inputCls} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </Field>
          {mode === 'register' && (
            <Field label="Şifre tekrar">
              <input className={inputCls} type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
            </Field>
          )}
          {error && <p className="rounded-xl bg-loss/15 px-3.5 py-3 text-sm text-loss">{error}</p>}
          <Button
            type="submit"
            variant="brass"
            size="lg"
            className="w-full"
            disabled={!username || !pw}
            onClick={mode === 'login' ? login : register}
          >
            {mode === 'login' ? 'Giriş yap' : 'Hesap aç'}
          </Button>
          {mode === 'register' && (
            <p className="text-center text-sm text-dim">Hesabınız admin onayından sonra açılır ve 1000 coin ile başlarsınız.</p>
          )}
          {mode === 'login' && <p className="text-center text-sm text-dim">Şifrenizi unuttuysanız admin sıfırlayabilir.</p>}
        </form>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="mb-10 text-center">
      <svg viewBox="0 0 200 110" className="mx-auto mb-5 w-44" aria-hidden>
        <rect x="10" y="8" width="180" height="94" rx="12" fill="#113629" stroke="#245a47" strokeWidth="2" />
        <line x1="100" y1="8" x2="100" y2="102" stroke="#245a47" strokeWidth="2" />
        <circle cx="100" cy="55" r="14" fill="none" stroke="#245a47" strokeWidth="2" />
        {[40, 80, 120, 160].map((x, i) => (
          <g key={x}>
            <line x1={x} y1="0" x2={x} y2="110" stroke="#a9bab3" strokeWidth="3" strokeLinecap="round" />
            {(i === 0 || i === 3 ? [55] : [32, 78]).map((y) => (
              <rect key={y} x={x - 5} y={y - 7} width="10" height="14" rx="3" fill={i % 2 === 0 ? '#3b82f6' : '#ef4444'} />
            ))}
          </g>
        ))}
        <circle cx="100" cy="55" r="5" fill="#f2c14e" />
      </svg>
      <h1 className="font-display text-4xl font-extrabold tracking-tight">Langırt Ligi</h1>
      <p className="mt-1.5 text-chrome">Maçlar, istatistikler ve iddia.</p>
    </div>
  );
}

export function PendingScreen() {
  const me = useStore((s) => s.me)!;
  const start = useStore((s) => s.start);
  return (
    <div className="felt-bg flex h-full flex-col items-center justify-center px-8 text-center">
      <h1 className="font-display text-3xl font-bold">{me.status === 'disabled' ? 'Hesabınız kapatıldı' : 'Onay bekleniyor'}</h1>
      <p className="mt-3 max-w-xs leading-relaxed text-chrome">
        {me.status === 'disabled'
          ? 'Hesabınız admin tarafından kapatıldı. Bir yanlışlık olduğunu düşünüyorsanız admin ile konuşun.'
          : `Merhaba ${me.display_name}. Hesabınızı admin onayladığında 1000 coin ile oynamaya başlayabilirsiniz.`}
      </p>
      <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
        <Button variant="primary" onClick={() => start(me.id)}>Tekrar kontrol et</Button>
        <Button variant="quiet" onClick={() => supabase.auth.signOut()}>Çıkış yap</Button>
      </div>
    </div>
  );
}

export function NotConfigured() {
  return (
    <div className="felt-bg flex h-full items-center justify-center px-8 text-center">
      <div>
        <h1 className="font-display text-3xl font-bold">Sunucu ayarlanmamış</h1>
        <p className="mt-3 leading-relaxed text-chrome">
          Bu sürüm Supabase adresi olmadan derlenmiş. GitHub'daki VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY ayarlarını ekleyip uygulamayı yeniden derleyin.
        </p>
      </div>
    </div>
  );
}
