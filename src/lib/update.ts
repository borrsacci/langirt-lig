// Yeni sürüm kontrolü: CI her derlemede version.json yükler
import { isNative } from './native';

export interface UpdateInfo {
  version: number;
  url: string;
}

export const currentVersion = Number(__APP_VERSION__) || 0;

export async function checkUpdate(): Promise<UpdateInfo | null> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base || !currentVersion || !isNative) return null;
  try {
    const r = await fetch(`${base}/storage/v1/object/public/app/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as UpdateInfo;
    if (j.version <= currentVersion) return null;
    // "Sonra" denen sürüm bir daha sorulmaz; daha yeni bir sürüm çıkınca tekrar haber verilir
    if (Number(safeGet(DISMISS_KEY)) >= j.version) return null;
    return j;
  } catch {
    return null;
  }
}

const DISMISS_KEY = 'langirt-update-dismissed';
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function dismissUpdate(version: number) {
  try {
    localStorage.setItem(DISMISS_KEY, String(version));
  } catch {
    /* depolama yoksa önemli değil */
  }
}
