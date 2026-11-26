import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { errText } from '../lib/api';
import { enablePush, type PushState, pushState, sendTestPush } from '../lib/push';
import { isNative } from '../lib/native';
import { Button, Card, cn, toast } from './kit';

const TEXT: Record<PushState, string> = {
  on: 'Açık. Bahisler açılınca ve maç sonuçlanınca bildirim gelir.',
  off: 'Kapalı. Bahisler açılınca ve maç sonuçlanınca haber almak için açın.',
  denied: 'Telefon ayarlarında bu uygulamanın bildirimleri engellenmiş. Ayarlar → Uygulamalar → Langırt Ligi → Bildirimler bölümünden izin verin.',
  unsupported: 'Bu cihazda veya bu sürümde bildirim desteklenmiyor.',
  'ios-install': "iPhone'da bildirim için önce Safari'de Paylaş → Ana Ekrana Ekle yapın, uygulamayı ana ekrandaki ikondan açın.",
};

function usePushState() {
  const [st, setSt] = useState<PushState | null>(null);
  useEffect(() => {
    pushState().then(setSt).catch(() => setSt('unsupported'));
  }, []);
  return [st, setSt] as const;
}

async function turnOn(set: (s: PushState) => void) {
  try {
    const s = await enablePush();
    set(s);
    if (s === 'on') {
      const r = await sendTestPush().catch(() => null);
      toast(r && r.sent > 0 ? 'Bildirimler açıldı. Deneme bildirimi gönderildi.' : 'Bildirimler açıldı.');
    } else if (s === 'denied') toast('İzin verilmedi. Telefon ayarlarından açabilirsiniz.', 'error');
  } catch (e) {
    toast(`Bildirim açılamadı: ${errText(e)}`, 'error');
  }
}

export function NotificationsCard() {
  const [st, setSt] = usePushState();
  if (!st || (st === 'unsupported' && !isNative)) return null; // web/iPhone sürümünde bildirim yok
  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <BellRing size={18} className={st === 'on' ? 'text-win' : 'text-chrome'} />
        <span className="font-semibold">Bildirimler</span>
      </div>
      <p className="text-sm leading-relaxed text-chrome">{TEXT[st]}</p>
      {st === 'off' && (
        <Button variant="brass" className="w-full" onClick={() => turnOn(setSt)}>
          Bildirimleri aç
        </Button>
      )}
      {st === 'on' && (
        <Button className="w-full" onClick={async () => {
          const r = await sendTestPush();
          toast(r.sent > 0 ? 'Deneme bildirimi gönderildi' : 'Bildirim gönderilemedi', r.sent > 0 ? 'ok' : 'error');
        }}>
          Deneme bildirimi gönder
        </Button>
      )}
    </Card>
  );
}

const DISMISS = 'langirt-push-prompt-dismissed';

/** Maç ekranında bir kez: bildirimler kapalıysa açmayı önerir */
export function PushPrompt() {
  const [st, setSt] = usePushState();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS) === '1';
    } catch {
      return false;
    }
  });
  if (hidden || (st !== 'off' && st !== 'ios-install')) return null;
  return (
    <Card className={cn('space-y-3 border border-brass/30 bg-brass/10')}>
      <div className="flex items-center gap-2 font-semibold text-brass">
        <BellRing size={18} /> Bahisler açılınca haber al
      </div>
      <p className="text-sm text-chrome">{st === 'ios-install' ? TEXT['ios-install'] : 'Kura çekilip oranlar çıkınca ve maç sonuçlanınca telefonuna bildirim gelsin.'}</p>
      <div className="flex gap-2">
        <Button
          variant="quiet"
          className="flex-1"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS, '1');
            } catch {
              /* önemsiz */
            }
            setHidden(true);
          }}
        >
          Şimdi değil
        </Button>
        {st === 'off' && (
          <Button variant="brass" className="flex-[1.6]" onClick={() => turnOn(setSt)}>
            Bildirimleri aç
          </Button>
        )}
      </div>
    </Card>
  );
}
