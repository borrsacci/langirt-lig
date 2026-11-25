import { App } from '@capacitor/app';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();

export async function initNative() {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0A2A21' });
  } catch {
    /* bazı cihazlarda desteklenmez */
  }
}

/** Android geri tuşu: önce açık pencereyi kapatır, sonra ana sekmeye döner, en son uygulamayı arka plana alır */
const backHandlers: (() => boolean)[] = [];
export function onBack(fn: () => boolean) {
  backHandlers.push(fn);
  return () => {
    const i = backHandlers.lastIndexOf(fn);
    if (i >= 0) backHandlers.splice(i, 1);
  };
}
if (isNative) {
  App.addListener('backButton', () => {
    for (let i = backHandlers.length - 1; i >= 0; i--) if (backHandlers[i]()) return;
    App.minimizeApp();
  });
}

export function onResume(fn: () => void) {
  if (isNative) {
    const h = App.addListener('resume', fn);
    return () => void h.then((x) => x.remove());
  }
  const v = () => document.visibilityState === 'visible' && fn();
  document.addEventListener('visibilitychange', v);
  return () => document.removeEventListener('visibilitychange', v);
}

export function tap() {
  if (isNative) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}
export function thump() {
  if (isNative) Haptics.impact({ style: ImpactStyle.Heavy }).catch(() => {});
  else navigator.vibrate?.(40);
}
export function buzz() {
  if (isNative) Haptics.notification({ type: NotificationType.Warning }).catch(() => {});
  else navigator.vibrate?.([200, 100, 200]);
}

let ctx: AudioContext | null = null;
// Android ses çalmak için bir kullanıcı dokunuşu bekler: ilk dokunuşta ses sistemi hazırlanır
function audio(): AudioContext | null {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => audio(), { once: true, capture: true });
/** Hakem düdüğü (süre bitince) */
export function whistle() {
  try {
    const ctx = audio();
    if (!ctx) throw new Error('ses yok');
    const t = ctx.currentTime;
    for (const [start, dur] of [[0, 0.35], [0.45, 0.8]] as const) {
      const osc = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = 2600;
      lfo.frequency.value = 28; // düdükteki bilye titreşimi
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain).connect(osc.frequency);
      osc.connect(gain).connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t + start);
      gain.gain.exponentialRampToValueAtTime(0.5, t + start + 0.03);
      gain.gain.setValueAtTime(0.5, t + start + dur - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      osc.start(t + start);
      lfo.start(t + start);
      osc.stop(t + start + dur);
      lfo.stop(t + start + dur);
    }
  } catch {
    /* ses desteklenmiyor */
  }
  buzz();
}

/** Canlı maçı kaydeden telefonun ekranı kapanmasın */
const KeepAwake = registerPlugin<{ set(o: { on: boolean }): Promise<void> }>('KeepAwake');
let lock: { release: () => Promise<void> } | null = null;
export async function keepAwake(on: boolean) {
  if (isNative) {
    await KeepAwake.set({ on }).catch(() => {});
    return;
  }
  try {
    if (on && !lock && 'wakeLock' in navigator) lock = await (navigator as any).wakeLock.request('screen');
    if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}

/** Görseli paylaşım menüsüyle paylaşır (WhatsApp vb.) */
export async function shareImage(blob: Blob, fileName: string, title: string) {
  if (isNative) {
    const data = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
    const f = await Filesystem.writeFile({ path: fileName, data, directory: Directory.Cache });
    await Share.share({ title, files: [f.uri] });
    return;
  }
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
