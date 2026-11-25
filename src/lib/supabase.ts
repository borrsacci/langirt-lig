import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isConfigured = Boolean(url && key);

export const supabase = createClient(url || 'http://localhost:54321', key || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'langirt-auth' },
  realtime: { params: { eventsPerSecond: 20 } },
});

/** Kullanıcı adıyla giriş: Supabase e-posta istediği için arka planda sabit bir alan adı kullanılır */
export const emailFor = (username: string) => `${username.trim().toLowerCase()}@users.langirt.app`;
