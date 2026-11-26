-- Bildirimler sadece Android uygulamasına gider: web/iPhone abonelikleri silinir ve yenisi kabul edilmez
delete from public.push_subscriptions where kind = 'web';

create or replace function public.register_push(p_kind text, p_token text, p_keys jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_active();
  if p_kind <> 'fcm' or coalesce(btrim(p_token), '') = '' or length(p_token) > 2000 then
    raise exception 'Bildirimler sadece Android uygulamasında' using errcode = 'P0001';
  end if;
  insert into push_subscriptions (user_id, kind, token, keys)
  values (auth.uid(), 'fcm', p_token, null)
  on conflict (token) do update set user_id = excluded.user_id, kind = excluded.kind, keys = null, updated_at = now();
end $$;
