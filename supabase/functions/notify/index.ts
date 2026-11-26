// Bildirim işlemleri:
//  - vapid:   web/iPhone aboneliği için sunucunun açık anahtarı
//  - test:    çağıran kişiye deneme bildirimi
//  - settled: admin maçı onaylayınca herkese sonuç bildirimi (bir kez)
import { createClient } from 'npm:@supabase/supabase-js@2';
import { cors, HttpError, isUuid, json } from '../_shared/http.ts';
import { getVapid, notifySettled, sendToUsers } from '../_shared/notify.ts';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
    if (body.action === 'vapid') return json({ publicKey: (await getVapid(svc)).publicKey });

    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (!u?.user) throw new HttpError(401, 'Oturum geçersiz');
    const { data: me } = await svc.from('profiles').select('is_admin,status').eq('id', u.user.id).single();
    if (me?.status !== 'active') throw new HttpError(403, 'Hesabınız aktif değil');

    if (body.action === 'test') {
      const r = await sendToUsers(svc, new Map([[u.user.id, { title: 'Bildirimler açık', body: 'Bahisler açılınca ve maç sonuçlanınca haber vereceğiz.' }]]));
      return json(r);
    }
    if (body.action === 'settled') {
      if (!me.is_admin) throw new HttpError(403, 'Bu işlem sadece admin içindir');
      if (!isUuid(body.match_id)) throw new HttpError(400, 'Geçersiz maç');
      return json(await notifySettled(svc, body.match_id));
    }
    throw new HttpError(400, 'Bilinmeyen işlem');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    console.error(e);
    return json({ error: e instanceof Error ? e.message : String(e) }, status);
  }
});
