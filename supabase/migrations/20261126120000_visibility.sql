-- =====================================================================
-- Kullanıcı bazlı görünürlük ve bildirim ayarı (sadece admin görür ve değiştirir)
--   full    : her şeyi görür (varsayılan)
--   no_live : açık / oynanan / onay bekleyen maçları görmez; onaylanmış sonuçları görür
--   none    : hiçbir maçı, istatistiği, kuponu ve sıralamayı görmez; sadece kendi hesabı
-- Kısıtlı kullanıcı bir maçta oynuyorsa o maçı görür ve yönetebilir.
-- Kısıtlı kullanıcılara bildirim gitmez; notify = false olanlara da gitmez.
-- =====================================================================

-- Yardımcı kontroller API'ye açık olmayan ayrı şemada: kullanıcılar bunları çağırıp
-- kendi görünürlük seviyelerini öğrenemez (RLS kuralları yine kullanabilir).
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create table public.profile_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  visibility text not null default 'full' check (visibility in ('full', 'no_live', 'none')),
  notify boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.profile_settings enable row level security;
-- politika yok: kullanıcılar kendi ayarlarını bile göremez; sadece admin fonksiyonları ve sunucu
revoke all on public.profile_settings from anon, authenticated;
grant select, insert, update, delete on public.profile_settings to service_role;

create or replace function private.my_visibility() returns text
language sql stable security definer set search_path = public as $$
  select case
    when not exists (select 1 from profiles where id = auth.uid() and status = 'active') then null
    when exists (select 1 from profiles where id = auth.uid() and is_admin) then 'full'
    else coalesce((select visibility from profile_settings where user_id = auth.uid()), 'full')
  end;
$$;

create or replace function private.can_see_match(p_status text, p_af uuid, p_ak uuid, p_bf uuid, p_bk uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case private.my_visibility()
    when 'full' then true
    when 'no_live' then p_status in ('approved', 'rejected', 'cancelled')
      or exists (select 1 from profiles where id = auth.uid() and player_id in (p_af, p_ak, p_bf, p_bk))
    when 'none' then exists (select 1 from profiles where id = auth.uid() and player_id in (p_af, p_ak, p_bf, p_bk))
    else false
  end;
$$;

create or replace function private.can_see_match_id(p_match uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select private.can_see_match(status, a_f, a_k, b_f, b_k) from matches where id = p_match), false);
$$;

-- Uygulamanın arayüz kararı için tek bilgi: maç (kura) başlatabilir mi. Görünürlük seviyesi söylenmez.
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('can_create_match', coalesce(private.my_visibility() = 'full', false));
$$;

-- ---------- Okuma kuralları ----------
drop policy matches_read on public.matches;
create policy matches_read on public.matches for select to authenticated
  using (private.can_see_match(status, a_f, a_k, b_f, b_k));
drop policy events_read on public.match_events;
create policy events_read on public.match_events for select to authenticated using (private.can_see_match_id(match_id));
drop policy markets_read on public.markets;
create policy markets_read on public.markets for select to authenticated using (private.can_see_match_id(match_id));
drop policy selections_read on public.selections;
create policy selections_read on public.selections for select to authenticated using (private.can_see_match_id(match_id));
drop policy bets_read on public.bets;
create policy bets_read on public.bets for select to authenticated using (
  user_id = auth.uid()
  or (private.can_see_match_id(match_id) and exists (select 1 from matches m where m.id = match_id and m.status <> 'open'))
);
drop policy profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or (is_active() and private.my_visibility() <> 'none'));

-- ---------- Güvenlik tanımlı (RLS'i aşan) okuma fonksiyonları da aynı kurala uyar ----------
create or replace function public.approved_history() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id, 'created_at', m.created_at, 'status', m.status,
    'a_f', m.a_f, 'a_k', m.a_k, 'b_f', m.b_f, 'b_k', m.b_k,
    'half1_ms', m.half1_ms, 'half2_ms', m.half2_ms, 'ended_early', m.ended_early,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'match_id', e.match_id, 'seq', e.seq, 'kind', e.kind, 'half', e.half, 'clock_ms', e.clock_ms,
        'team', e.team, 'player_id', e.player_id, 'role', e.role, 'keeper_id', e.keeper_id,
        'last_ball', e.last_ball, 'ends_half', e.ends_half, 'deleted_at', e.deleted_at) order by e.seq)
      from match_events e where e.match_id = m.id and e.deleted_at is null), '[]'::jsonb)
  ) order by m.created_at), '[]'::jsonb)
  from matches m
  where m.status = 'approved'
    and (auth.role() = 'service_role' or (is_active() and private.can_see_match(m.status, m.a_f, m.a_k, m.b_f, m.b_k)));
$$;

create or replace function public.get_leaderboard()
returns table (user_id uuid, display_name text, balance numeric, bets_total int, bets_won int, bets_settled int,
               staked numeric, returned numeric, profit numeric, biggest_win numeric, best_odds numeric)
language sql stable security definer set search_path = public as $$
  select p.id, p.display_name, p.balance,
    count(b.id)::int,
    count(b.id) filter (where b.status = 'won')::int,
    count(b.id) filter (where b.status in ('won', 'lost'))::int,
    coalesce(sum(b.stake) filter (where b.status in ('won', 'lost')), 0),
    coalesce(sum(b.payout) filter (where b.status = 'won'), 0),
    coalesce(sum(b.payout) filter (where b.status = 'won'), 0) - coalesce(sum(b.stake) filter (where b.status in ('won', 'lost')), 0),
    coalesce(max(b.payout - b.stake) filter (where b.status = 'won'), 0),
    coalesce(max(b.odds) filter (where b.status = 'won'), 0)
  from profiles p left join bets b on b.user_id = p.id
  where p.status = 'active' and is_active()
    and (private.my_visibility() <> 'none' or p.id = auth.uid())
  group by p.id
  order by p.balance desc;
$$;

-- Bahis: görülemeyen maça bahis yapılamaz (seçenek kimliği bir şekilde bilinse bile)
create or replace function public.place_bet(p_selection uuid, p_stake numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me profiles; s selections; m matches; v_bet uuid; nb numeric;
begin
  me := require_active();
  select * into s from selections where id = p_selection;
  if s.id is null or not private.can_see_match_id(s.match_id) then raise exception 'Seçenek bulunamadı' using errcode = 'P0001'; end if;
  -- maç satırını kilitle: "Maçı Başlat" ile aynı anda gelen bahis güvenle reddedilir
  select * into m from matches where id = s.match_id for share;
  if m.status <> 'open' then raise exception 'Bu maçın bahisleri kapandı' using errcode = 'P0001'; end if;
  if s.odds is null then raise exception 'Bu seçenek bahse kapalı' using errcode = 'P0001'; end if;
  if p_stake is null or p_stake < 2 then raise exception 'En az bahis 2 coin' using errcode = 'P0001'; end if;
  if p_stake <> round(p_stake, 2) then raise exception 'Tutar en fazla 2 ondalık olabilir' using errcode = 'P0001'; end if;
  if me.player_id is not null and me.player_id in (m.a_f, m.a_k, m.b_f, m.b_k)
     and not (me.player_id = any (s.allowed_players)) then
    raise exception 'Kendi maçınızda sadece kendi lehinize veya beraberliğe bahis yapabilirsiniz' using errcode = 'P0001';
  end if;
  select * into me from profiles where id = me.id for update;
  if me.balance < p_stake then raise exception 'Yetersiz bakiye' using errcode = 'P0001'; end if;
  insert into bets (user_id, match_id, selection_id, stake, odds)
  values (me.id, m.id, s.id, p_stake, s.odds) returning id into v_bet;
  nb := ledger(me.id, -p_stake, 'bet', v_bet, m.id, null);
  return jsonb_build_object('bet_id', v_bet, 'balance', nb);
end $$;

create or replace function public.tick(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
begin
  perform require_active();
  if not private.can_see_match_id(p_match) then raise exception 'Maç bulunamadı' using errcode = 'P0001'; end if;
  return normalize_clock(p_match);
end $$;

-- ---------- Admin ----------
create or replace function public.admin_list_access()
returns table (user_id uuid, visibility text, notify boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_admin();
  return query select p.id, coalesce(s.visibility, 'full'), coalesce(s.notify, true)
    from profiles p left join profile_settings s on s.user_id = p.id;
end $$;

create or replace function public.admin_set_access(p_user uuid, p_visibility text, p_notify boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_visibility not in ('full', 'no_live', 'none') then raise exception 'Geçersiz görünürlük'; end if;
  if exists (select 1 from profiles where id = p_user and is_admin) and p_visibility <> 'full' then
    raise exception 'Admin hesabı kısıtlanamaz' using errcode = 'P0001';
  end if;
  insert into profile_settings (user_id, visibility, notify) values (p_user, p_visibility, coalesce(p_notify, true))
  on conflict (user_id) do update set visibility = excluded.visibility, notify = excluded.notify, updated_at = now();
end $$;

revoke execute on function private.my_visibility(), private.can_see_match(text, uuid, uuid, uuid, uuid), private.can_see_match_id(uuid)
  from public, anon;
grant execute on function private.my_visibility(), private.can_see_match(text, uuid, uuid, uuid, uuid), private.can_see_match_id(uuid)
  to authenticated, service_role;
revoke execute on function public.my_access(), public.admin_list_access(), public.admin_set_access(uuid, text, boolean) from public, anon;
grant execute on function public.my_access(), public.admin_list_access(), public.admin_set_access(uuid, text, boolean) to authenticated;
