-- =====================================================================
-- Bildirimler: telefon/tarayıcı abonelikleri ve sunucu anahtarları
-- =====================================================================

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('fcm', 'web')),
  token text not null unique, -- FCM kayıt anahtarı veya web push adresi (endpoint)
  keys jsonb, -- web push: { p256dh, auth }
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

-- Sunucunun kendi ürettiği anahtarlar (ör. web push VAPID). Kullanıcılar asla göremez.
create table public.app_secrets (
  name text primary key,
  value jsonb not null,
  created_at timestamptz not null default now()
);

-- Aynı bildirim iki kez gitmesin
alter table public.matches add column notified_open_at timestamptz;
alter table public.matches add column notified_settled_at timestamptz;

alter table public.push_subscriptions enable row level security;
alter table public.app_secrets enable row level security;
-- politika yok: kullanıcılar doğrudan erişemez, sadece aşağıdaki fonksiyonlar ve sunucu
revoke all on public.push_subscriptions, public.app_secrets from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions, public.app_secrets to service_role;
grant update (notified_open_at, notified_settled_at) on public.matches to service_role;

create or replace function public.register_push(p_kind text, p_token text, p_keys jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_active();
  if p_kind not in ('fcm', 'web') or coalesce(btrim(p_token), '') = '' or length(p_token) > 2000 then
    raise exception 'Geçersiz bildirim kaydı' using errcode = 'P0001';
  end if;
  if p_kind = 'web' and (p_keys ->> 'p256dh' is null or p_keys ->> 'auth' is null) then
    raise exception 'Geçersiz bildirim kaydı' using errcode = 'P0001';
  end if;
  -- aynı cihaz başka hesapla kullanılmışsa abonelik yeni hesaba geçer
  insert into push_subscriptions (user_id, kind, token, keys)
  values (auth.uid(), p_kind, p_token, p_keys)
  on conflict (token) do update set user_id = excluded.user_id, kind = excluded.kind, keys = excluded.keys, updated_at = now();
end $$;

create or replace function public.unregister_push(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_active();
  delete from push_subscriptions where token = p_token and user_id = auth.uid();
end $$;

-- Çıkış yaparken bu cihazın aboneliği silinir (oturum hâlâ geçerliyken çağrılır)
create or replace function public.my_push_count() returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::int from push_subscriptions where user_id = auth.uid();
$$;

revoke execute on function public.register_push(text, text, jsonb), public.unregister_push(text), public.my_push_count()
  from public, anon;
grant execute on function public.register_push(text, text, jsonb), public.unregister_push(text), public.my_push_count()
  to authenticated;
