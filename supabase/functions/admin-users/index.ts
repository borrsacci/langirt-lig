// Admin: kullanıcının şifresini sıfırlama (şifremi unuttum durumları için)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, HttpError, isUuid, json } from '../_shared/http.ts';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (!u?.user) throw new HttpError(401, 'Oturum geçersiz');
    const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
    const { data: me } = await svc.from('profiles').select('is_admin,status').eq('id', u.user.id).single();
    if (!me?.is_admin || me.status !== 'active') throw new HttpError(403, 'Bu işlem sadece admin içindir');

    const body = await req.json().catch(() => ({}));
    if (body.action === 'reset_password') {
      if (!isUuid(body.user_id)) throw new HttpError(400, 'Geçersiz kullanıcı');
      if (typeof body.password !== 'string' || body.password.length < 6) throw new HttpError(400, 'Şifre en az 6 karakter olmalı');
      const { error } = await svc.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) throw new HttpError(400, error.message);
      return json({ ok: true });
    }
    throw new HttpError(400, 'Bilinmeyen işlem');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
