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
    return j.version > currentVersion ? j : null;
  } catch {
    return null;
  }
}
