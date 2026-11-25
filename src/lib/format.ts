const coinFmt = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const oddsFmt = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctFmt = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

export const coin = (n: number | string) => coinFmt.format(Number(n));
export const odds = (n: number | string) => oddsFmt.format(Number(n));
export const pct = (x: number) => `%${pctFmt.format(x * 100)}`;
export const signed = (n: number) => (n > 0 ? '+' : '') + coinFmt.format(n);

export function clock(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function minutes(ms: number): string {
  const m = ms / 60000;
  return m < 10 ? `${m.toFixed(1).replace('.', ',')} dk` : `${Math.round(m)} dk`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const t = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Bugün ${t}`;
  if (d.toDateString() === y.toDateString()) return `Dün ${t}`;
  return `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} ${t}`;
}

/** Kuruş hassasiyetinde güvenli çarpım (sunucuyla aynı yuvarlama) */
export const payout = (stake: number, o: number) => Math.round(stake * o * 100) / 100;

/** Kuponun kazanırsa ödeyeceği tutar: (yatırılan − kasa kesintisi) × oran */
export const betWin = (b: { stake: number; commission: number; odds: number }) => payout(b.stake - b.commission, b.odds);

/** Sonuçlanmış kuponun net etkisi (kesinti dahil) */
export function betNet(b: { status: string; stake: number; payout: number }): number | null {
  if (b.status === 'won') return Math.round((b.payout - b.stake) * 100) / 100;
  if (b.status === 'lost') return -b.stake;
  if (b.status === 'void' || b.status === 'cancelled') return 0;
  return null;
}
