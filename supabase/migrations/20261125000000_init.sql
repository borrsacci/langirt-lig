-- =====================================================================
-- Langırt Ligi: veritabanı şeması
-- Tüm para (coin) ve maç durumu değişiklikleri sadece aşağıdaki SECURITY DEFINER
-- fonksiyonlarla yapılır; tablolara doğrudan yazma yetkisi yoktur. Böylece
-- uygulama değiştirilse bile kimse kendine coin yazamaz, kapanmış maça bahis
-- yapamaz, oranları değiştiremez.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tablolar ----------

create table public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 24),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index players_name_uq on public.players (lower(btrim(name)));

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null check (char_length(btrim(display_name)) between 2 and 24),
  is_admin boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  balance numeric(14, 2) not null default 0 check (balance >= 0),
  bonus_granted boolean not null default false,
  player_id uuid unique references public.players (id),
  created_at timestamptz not null default now()
);
create unique index one_admin on public.profiles ((true)) where is_admin;

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  status text not null default 'open'
    check (status in ('open', 'live', 'review', 'pending', 'approved', 'rejected', 'cancelled')),
  a_f uuid not null references public.players (id),
  a_k uuid not null references public.players (id),
  b_f uuid not null references public.players (id),
  b_k uuid not null references public.players (id),
  half smallint not null default 1 check (half in (1, 2)),
  clock_running boolean not null default false,
  clock_remaining_ms integer not null default 180000 check (clock_remaining_ms between 0 and 180000),
  clock_updated_at timestamptz not null default now(),
  last_ball boolean not null default false,
  half1_ms integer check (half1_ms between 0 and 180000),
  half2_ms integer check (half2_ms between 0 and 180000),
  ended_early boolean not null default false,
  started_at timestamptz,
  finished_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  bets_voided boolean not null default false,
  decision_note text,
  model jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  constraint four_distinct check (
    a_f <> a_k and a_f <> b_f and a_f <> b_k and a_k <> b_f and a_k <> b_k and b_f <> b_k
  )
);
-- Masada aynı anda tek maç: bahis açık veya oynanan en fazla bir maç olabilir
create unique index one_active_match on public.matches ((true)) where status in ('open', 'live');
create index matches_status_idx on public.matches (status, created_at desc);

create table public.match_events (
  id uuid primary key, -- istemci üretir: aynı istek iki kez gelirse tek kayıt olur
  match_id uuid not null references public.matches (id) on delete cascade,
  seq bigint generated always as identity,
  kind text not null check (kind in ('goal', 'swap')),
  half smallint not null check (half in (1, 2)),
  clock_ms integer not null check (clock_ms between 0 and 180000),
  team text not null check (team in ('A', 'B')),
  player_id uuid references public.players (id),
  role text check (role in ('F', 'K')),
  keeper_id uuid references public.players (id),
  last_ball boolean not null default false,
  ends_half boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint goal_has_player check (kind <> 'goal' or (player_id is not null and role is not null))
);
create index match_events_match_idx on public.match_events (match_id, seq);

create table public.markets (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  code text not null,
  title text not null,
  sort integer not null,
  unique (match_id, code)
);

create table public.selections (
  id uuid primary key default gen_random_uuid(),
  market_id uuid not null references public.markets (id) on delete cascade,
  match_id uuid not null references public.matches (id) on delete cascade,
  code text not null,
  label text not null,
  rule jsonb not null,
  prob double precision not null check (prob >= 0 and prob <= 1),
  odds numeric(6, 2) check (odds is null or odds >= 1.01),
  allowed_players uuid[] not null default '{}',
  sort integer not null,
  result text check (result in ('won', 'lost', 'void')),
  unique (market_id, code)
);
create index selections_match_idx on public.selections (match_id);

create table public.bets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  match_id uuid not null references public.matches (id),
  selection_id uuid not null references public.selections (id),
  stake numeric(14, 2) not null check (stake >= 2),
  odds numeric(6, 2) not null,
  status text not null default 'open' check (status in ('open', 'won', 'lost', 'void', 'cancelled')),
  payout numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index bets_user_idx on public.bets (user_id, created_at desc);
create index bets_match_idx on public.bets (match_id);

create table public.transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id),
  amount numeric(14, 2) not null,
  balance_after numeric(14, 2) not null,
  kind text not null check (kind in ('signup', 'bet', 'payout', 'refund', 'admin')),
  bet_id uuid references public.bets (id),
  match_id uuid references public.matches (id),
  note text,
  created_at timestamptz not null default now()
);
create index transactions_user_idx on public.transactions (user_id, id desc);

-- ---------- Yardımcılar ----------

create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and status = 'active' and is_admin);
$$;

create or replace function public.require_active() returns profiles
language plpgsql stable security definer set search_path = public as $$
declare p profiles;
begin
  select * into p from profiles where id = auth.uid();
  if p.id is null then raise exception 'Giriş yapmalısınız' using errcode = 'P0001'; end if;
  if p.status <> 'active' then raise exception 'Hesabınız henüz onaylanmadı' using errcode = 'P0001'; end if;
  return p;
end $$;

create or replace function public.require_admin() returns profiles
language plpgsql stable security definer set search_path = public as $$
declare p profiles;
begin
  p := require_active();
  if not p.is_admin then raise exception 'Bu işlem sadece admin içindir' using errcode = 'P0001'; end if;
  return p;
end $$;

create or replace function public.server_now() returns timestamptz
language sql stable as $$ select now(); $$;

-- Bakiye hareketi (tek giriş noktası): bakiye + defter kaydı birlikte
create or replace function public.ledger(p_user uuid, p_amount numeric, p_kind text, p_bet uuid, p_match uuid, p_note text)
returns numeric language plpgsql security definer set search_path = public as $$
declare nb numeric;
begin
  update profiles set balance = balance + p_amount where id = p_user returning balance into nb;
  if nb is null then raise exception 'Kullanıcı bulunamadı'; end if;
  if nb < 0 then raise exception 'Yetersiz bakiye' using errcode = 'P0001'; end if;
  insert into transactions (user_id, amount, balance_after, kind, bet_id, match_id, note)
  values (p_user, p_amount, nb, p_kind, p_bet, p_match, p_note);
  return nb;
end $$;

-- ---------- Kayıt ----------

create or replace function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from profiles where username = lower(btrim(p_username)));
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_username text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  v_name text := btrim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  v_first boolean;
  v_player uuid;
begin
  if v_name = '' then v_name := v_username; end if;
  perform pg_advisory_xact_lock(4242);
  v_first := not exists (select 1 from profiles);
  insert into profiles (id, username, display_name, is_admin, status)
  values (new.id, v_username, v_name, v_first, case when v_first then 'active' else 'pending' end);
  if v_first then
    -- İlk kayıt olan hesap admin olur ve hemen aktifleşir
    select id into v_player from players where lower(btrim(name)) = lower(v_name);
    if v_player is null then insert into players (name) values (v_name) returning id into v_player; end if;
    update profiles set player_id = v_player, bonus_granted = true where id = new.id;
    perform ledger(new.id, 1000, 'signup', null, null, 'Hoş geldin bonusu');
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- Admin: kullanıcı ve oyuncu yönetimi ----------

create or replace function public.admin_approve_user(p_user uuid, p_player uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare u profiles; v_player uuid := p_player;
begin
  perform require_admin();
  select * into u from profiles where id = p_user for update;
  if u.id is null then raise exception 'Kullanıcı bulunamadı' using errcode = 'P0001'; end if;
  if u.status = 'active' then return; end if;
  if u.player_id is null then
    if v_player is null then
      select id into v_player from players where lower(btrim(name)) = lower(btrim(u.display_name));
      if v_player is null then insert into players (name) values (btrim(u.display_name)) returning id into v_player; end if;
    end if;
    if exists (select 1 from profiles where player_id = v_player and id <> p_user) then
      raise exception 'Bu oyuncu başka bir hesaba bağlı' using errcode = 'P0001';
    end if;
    update players set active = true where id = v_player;
    update profiles set player_id = v_player where id = p_user;
  end if;
  update profiles set status = 'active' where id = p_user;
  if not u.bonus_granted then
    update profiles set bonus_granted = true where id = p_user;
    perform ledger(p_user, 1000, 'signup', null, null, 'Hoş geldin bonusu');
  end if;
end $$;

create or replace function public.admin_set_user_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_user = auth.uid() then raise exception 'Kendi hesabınızı değiştiremezsiniz' using errcode = 'P0001'; end if;
  if p_status not in ('active', 'disabled') then raise exception 'Geçersiz durum'; end if;
  if p_status = 'active' then perform admin_approve_user(p_user, null); return; end if;
  update profiles set status = p_status where id = p_user;
end $$;

create or replace function public.admin_link_player(p_user uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if exists (select 1 from profiles where player_id = p_player and id <> p_user) then
    raise exception 'Bu oyuncu başka bir hesaba bağlı' using errcode = 'P0001';
  end if;
  update profiles set player_id = p_player where id = p_user;
end $$;

create or replace function public.admin_add_player(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  perform require_admin();
  insert into players (name) values (btrim(p_name)) returning id into v;
  return v;
exception when unique_violation then
  raise exception 'Bu isimde bir oyuncu zaten var' using errcode = 'P0001';
end $$;

create or replace function public.admin_update_player(p_player uuid, p_name text, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  update players set name = btrim(p_name), active = p_active where id = p_player;
exception when unique_violation then
  raise exception 'Bu isimde bir oyuncu zaten var' using errcode = 'P0001';
end $$;

create or replace function public.admin_adjust_balance(p_user uuid, p_amount numeric, p_note text)
returns numeric language plpgsql security definer set search_path = public as $$
begin
  perform require_admin();
  if p_amount = 0 or p_amount <> round(p_amount, 2) then raise exception 'Geçersiz tutar' using errcode = 'P0001'; end if;
  perform 1 from profiles where id = p_user for update;
  return ledger(p_user, p_amount, 'admin', null, null, coalesce(nullif(btrim(p_note), ''), 'Admin düzeltmesi'));
end $$;

-- ---------- Maç: saat ve yetki ----------

-- Saatin şu anki kalan süresi (sunucu zamanına göre)
create or replace function public.clock_remaining(m matches) returns integer
language sql stable as $$
  select case when m.clock_running
    then greatest(0, m.clock_remaining_ms - floor(extract(epoch from (now() - m.clock_updated_at)) * 1000)::int)
    else m.clock_remaining_ms end;
$$;

-- Süre bittiyse maçı "son top" durumuna çeker. Bitiş anı tam olarak kaydedilir.
create or replace function public.normalize_clock(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  select * into m from matches where id = p_match for update;
  if m.status = 'live' and m.clock_running and clock_remaining(m) = 0 then
    update matches set clock_running = false, clock_remaining_ms = 0, last_ball = true,
      clock_updated_at = m.clock_updated_at + make_interval(secs => m.clock_remaining_ms / 1000.0),
      version = version + 1
    where id = p_match returning * into m;
  end if;
  return m;
end $$;

create or replace function public.can_control(m matches) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (is_active() and (
    m.created_by = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid()
               and p.player_id in (m.a_f, m.a_k, m.b_f, m.b_k))));
$$;

create or replace function public.lock_controlled(p_match uuid, p_statuses text[]) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  perform require_active();
  m := normalize_clock(p_match);
  if m.id is null then raise exception 'Maç bulunamadı' using errcode = 'P0001'; end if;
  if not can_control(m) then raise exception 'Bu maçı sadece kaydı başlatan, oyuncular veya admin yönetebilir' using errcode = 'P0001'; end if;
  if not (m.status = any (p_statuses)) then raise exception 'Maç bu işlem için uygun durumda değil (%)', m.status using errcode = 'P0001'; end if;
  return m;
end $$;

-- Şu anki kadro (mevki değişimleri uygulanmış)
create or replace function public.current_lineup(m matches, out af uuid, out ak uuid, out bf uuid, out bk uuid)
language plpgsql stable security definer set search_path = public as $$
begin
  af := m.a_f; ak := m.a_k; bf := m.b_f; bk := m.b_k;
  if exists (select 1 from match_events where match_id = m.id and kind = 'swap' and team = 'A' and deleted_at is null) then
    af := m.a_k; ak := m.a_f;
  end if;
  if exists (select 1 from match_events where match_id = m.id and kind = 'swap' and team = 'B' and deleted_at is null) then
    bf := m.b_k; bk := m.b_f;
  end if;
end $$;

-- ---------- Maç yaşam döngüsü ----------

-- Sadece Edge Function (service_role) çağırabilir: oranlar sunucuda hesaplanır
create or replace function public.svc_create_match(p_created_by uuid, p_lineup jsonb, p_markets jsonb, p_model jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_match uuid; v_market uuid; mk jsonb; sel jsonb; i int := 0; j int;
  v_af uuid := (p_lineup ->> 'AF')::uuid; v_ak uuid := (p_lineup ->> 'AK')::uuid;
  v_bf uuid := (p_lineup ->> 'BF')::uuid; v_bk uuid := (p_lineup ->> 'BK')::uuid;
begin
  if not exists (select 1 from profiles where id = p_created_by and status = 'active') then
    raise exception 'Hesabınız aktif değil' using errcode = 'P0001';
  end if;
  if (select count(*) from players where id in (v_af, v_ak, v_bf, v_bk) and active) <> 4 then
    raise exception 'Kadroda geçersiz veya pasif oyuncu var' using errcode = 'P0001';
  end if;
  if exists (select 1 from matches where status in ('open', 'live')) then
    raise exception 'Zaten açık veya devam eden bir maç var' using errcode = 'P0001';
  end if;
  insert into matches (created_by, a_f, a_k, b_f, b_k, model)
  values (p_created_by, v_af, v_ak, v_bf, v_bk, coalesce(p_model, '{}'::jsonb)) returning id into v_match;
  for mk in select * from jsonb_array_elements(p_markets) loop
    i := i + 1;
    insert into markets (match_id, code, title, sort) values (v_match, mk ->> 'code', mk ->> 'title', i) returning id into v_market;
    j := 0;
    for sel in select * from jsonb_array_elements(mk -> 'selections') loop
      j := j + 1;
      insert into selections (market_id, match_id, code, label, rule, prob, odds, allowed_players, sort)
      values (v_market, v_match, sel ->> 'code', sel ->> 'label', sel -> 'rule', (sel ->> 'prob')::float8,
              nullif(sel ->> 'odds', '')::numeric,
              coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(sel -> 'allowed') x), '{}'), j);
    end loop;
  end loop;
  return v_match;
exception when unique_violation then
  raise exception 'Zaten açık veya devam eden bir maç var' using errcode = 'P0001';
end $$;

-- Açık/oynanan maçtaki bahisleri iade eder
create or replace function public.refund_match_bets(p_match uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare b bets;
begin
  for b in select * from bets where match_id = p_match and status = 'open' order by created_at for update loop
    update bets set status = 'void', payout = b.stake, settled_at = now() where id = b.id;
    perform ledger(b.user_id, b.stake, 'refund', b.id, p_match, p_note);
  end loop;
end $$;

create or replace function public.cancel_match(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  perform require_active();
  m := normalize_clock(p_match);
  if m.id is null then raise exception 'Maç bulunamadı' using errcode = 'P0001'; end if;
  if m.status = 'open' then
    if not can_control(m) then raise exception 'Bu maçı iptal etme yetkiniz yok' using errcode = 'P0001'; end if;
  elsif m.status in ('live', 'review', 'pending') then
    if not is_admin() then raise exception 'Başlamış bir maçı sadece admin iptal edebilir' using errcode = 'P0001'; end if;
  else
    raise exception 'Bu maç iptal edilemez' using errcode = 'P0001';
  end if;
  update matches set status = 'cancelled', clock_running = false, decided_at = now(), decided_by = auth.uid(),
    bets_voided = true, version = version + 1 where id = p_match;
  perform refund_match_bets(p_match, 'Maç iptal edildi');
end $$;

create or replace function public.start_match(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  m := lock_controlled(p_match, array['open']);
  update matches set status = 'live', started_at = now(), clock_running = true,
    clock_remaining_ms = 180000, clock_updated_at = now(), version = version + 1
  where id = p_match returning * into m;
  return m;
end $$;

create or replace function public.set_clock(p_match uuid, p_running boolean) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  m := lock_controlled(p_match, array['live']);
  if m.last_ball or m.clock_running = p_running then return m; end if;
  update matches set clock_running = p_running, clock_remaining_ms = clock_remaining(m),
    clock_updated_at = now(), version = version + 1
  where id = p_match returning * into m;
  return m;
end $$;

-- Süre bitimini istemci bildirir (sunucu zaten kendi saatine göre kontrol eder)
create or replace function public.tick(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
begin
  perform require_active();
  return normalize_clock(p_match);
end $$;

create or replace function public.record_goal(p_match uuid, p_event uuid, p_player uuid, p_client_remaining_ms integer default null)
returns matches language plpgsql security definer set search_path = public as $$
declare
  m matches; l record; v_team text; v_role text; v_keeper uuid; v_elapsed int; v_last boolean;
begin
  if exists (select 1 from match_events where id = p_event) then
    select * into m from matches where id = p_match; return m; -- tekrar eden istek
  end if;
  m := lock_controlled(p_match, array['live']);
  select * into l from current_lineup(m);
  if p_player = l.af then v_team := 'A'; v_role := 'F'; v_keeper := l.bk;
  elsif p_player = l.ak then v_team := 'A'; v_role := 'K'; v_keeper := l.bk;
  elsif p_player = l.bf then v_team := 'B'; v_role := 'F'; v_keeper := l.ak;
  elsif p_player = l.bk then v_team := 'B'; v_role := 'K'; v_keeper := l.ak;
  else raise exception 'Bu oyuncu maçta değil' using errcode = 'P0001'; end if;

  v_last := m.last_ball;
  v_elapsed := 180000 - clock_remaining(m);
  -- Süre bitiminden en fazla 3 sn önce ekranda süre varken basılan gol, son top sayılmaz
  -- (ağ gecikmesi yüzünden normal bir golün yarıyı bitirmesini önler)
  if v_last and p_client_remaining_ms is not null and p_client_remaining_ms > 0
     and now() - m.clock_updated_at < interval '3 seconds' then
    v_last := false;
    v_elapsed := greatest(0, 180000 - least(p_client_remaining_ms, 3000));
  end if;

  insert into match_events (id, match_id, kind, half, clock_ms, team, player_id, role, keeper_id, last_ball, ends_half, created_by)
  values (p_event, p_match, 'goal', m.half, least(180000, greatest(0, v_elapsed)), v_team, p_player, v_role, v_keeper,
          v_last, v_last, auth.uid());

  if v_last then
    if m.half = 1 then
      update matches set half = 2, half1_ms = 180000, last_ball = false, clock_running = false,
        clock_remaining_ms = 180000, clock_updated_at = now(), version = version + 1
      where id = p_match returning * into m;
    else
      update matches set status = 'review', half2_ms = 180000, finished_at = now(), version = version + 1
      where id = p_match returning * into m;
    end if;
  else
    update matches set version = version + 1 where id = p_match returning * into m;
  end if;
  return m;
end $$;

create or replace function public.swap_roles(p_match uuid, p_event uuid, p_team text) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  if exists (select 1 from match_events where id = p_event) then
    select * into m from matches where id = p_match; return m;
  end if;
  m := lock_controlled(p_match, array['live']);
  if p_team not in ('A', 'B') then raise exception 'Geçersiz takım'; end if;
  if exists (select 1 from match_events where match_id = p_match and kind = 'swap' and team = p_team and deleted_at is null) then
    raise exception 'Bu takım mevki değişikliği hakkını kullandı' using errcode = 'P0001';
  end if;
  insert into match_events (id, match_id, kind, half, clock_ms, team, created_by)
  values (p_event, p_match, 'swap', m.half, 180000 - clock_remaining(m), p_team, auth.uid());
  update matches set version = version + 1 where id = p_match returning * into m;
  return m;
end $$;

create or replace function public.undo_event(p_match uuid, p_event uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; e match_events; v_latest bigint;
begin
  m := lock_controlled(p_match, array['live', 'review']);
  select * into e from match_events where id = p_event and match_id = p_match and deleted_at is null for update;
  if e.id is null then raise exception 'Kayıt bulunamadı' using errcode = 'P0001'; end if;
  select max(seq) into v_latest from match_events where match_id = p_match and deleted_at is null;

  if e.kind = 'swap' then
    if e.seq <> v_latest or m.status <> 'live' then
      raise exception 'Mevki değişikliği sadece son işlemse geri alınabilir' using errcode = 'P0001';
    end if;
  elsif e.ends_half then
    if e.seq <> v_latest then raise exception 'Yarıyı bitiren gol sadece son işlemse geri alınabilir' using errcode = 'P0001'; end if;
    if e.half = 1 then
      if m.half <> 2 or m.status <> 'live' or m.clock_running or m.clock_remaining_ms <> 180000 then
        raise exception 'İkinci yarı başladıktan sonra ilk yarıyı bitiren gol geri alınamaz' using errcode = 'P0001';
      end if;
      update matches set half = 1, half1_ms = null, last_ball = true, clock_remaining_ms = 0,
        clock_updated_at = now() - interval '1 hour' where id = p_match;
    else
      update matches set status = 'live', half2_ms = null, finished_at = null, last_ball = true,
        clock_running = false, clock_remaining_ms = 0, clock_updated_at = now() - interval '1 hour' where id = p_match;
    end if;
  end if;
  update match_events set deleted_at = now() where id = p_event;
  update matches set version = version + 1 where id = p_match returning * into m;
  return m;
end $$;

-- Süre bitmeden maçı sonlandırma (ör. oyuncu gitmek zorunda kaldı)
create or replace function public.finish_early(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches; v_elapsed int;
begin
  m := lock_controlled(p_match, array['live']);
  v_elapsed := 180000 - clock_remaining(m);
  if m.half = 1 then
    update matches set half1_ms = v_elapsed, half2_ms = 0 where id = p_match;
  else
    update matches set half2_ms = v_elapsed where id = p_match;
  end if;
  update matches set status = 'review', ended_early = true, clock_running = false,
    clock_remaining_ms = clock_remaining(m), clock_updated_at = now(), finished_at = now(), version = version + 1
  where id = p_match returning * into m;
  return m;
end $$;

-- Yanlışlıkla erken bitirilen maça devam
create or replace function public.resume_match(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  m := lock_controlled(p_match, array['review']);
  if not m.ended_early then raise exception 'Bu maç süresi dolarak bitti; son golü geri alarak devam edebilirsiniz' using errcode = 'P0001'; end if;
  update matches set status = 'live', ended_early = false, finished_at = null, clock_running = false,
    clock_updated_at = now(),
    half1_ms = case when half = 1 then null else half1_ms end,
    half2_ms = null, version = version + 1
  where id = p_match returning * into m;
  return m;
end $$;

create or replace function public.submit_match(p_match uuid) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  m := lock_controlled(p_match, array['review']);
  update matches set status = 'pending', submitted_at = now(), version = version + 1
  where id = p_match returning * into m;
  return m;
end $$;

-- Admin, onaydan önce gol ekleyip silebilir
create or replace function public.admin_add_goal(p_match uuid, p_event uuid, p_half smallint, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m matches; v_team text; v_role text; v_keeper uuid;
  af uuid; ak uuid; bf uuid; bk uuid;
begin
  perform require_admin();
  select * into m from matches where id = p_match for update;
  if m.status not in ('review', 'pending') then raise exception 'Sadece onay bekleyen maç düzenlenebilir' using errcode = 'P0001'; end if;
  if p_half not in (1, 2) then raise exception 'Geçersiz yarı'; end if;
  -- o yarının sonundaki kadro
  af := m.a_f; ak := m.a_k; bf := m.b_f; bk := m.b_k;
  if exists (select 1 from match_events where match_id = p_match and kind = 'swap' and team = 'A' and half <= p_half and deleted_at is null) then
    af := m.a_k; ak := m.a_f; end if;
  if exists (select 1 from match_events where match_id = p_match and kind = 'swap' and team = 'B' and half <= p_half and deleted_at is null) then
    bf := m.b_k; bk := m.b_f; end if;
  if p_player = af then v_team := 'A'; v_role := 'F'; v_keeper := bk;
  elsif p_player = ak then v_team := 'A'; v_role := 'K'; v_keeper := bk;
  elsif p_player = bf then v_team := 'B'; v_role := 'F'; v_keeper := ak;
  elsif p_player = bk then v_team := 'B'; v_role := 'K'; v_keeper := ak;
  else raise exception 'Bu oyuncu maçta değil' using errcode = 'P0001'; end if;
  insert into match_events (id, match_id, kind, half, clock_ms, team, player_id, role, keeper_id, created_by)
  values (p_event, p_match, 'goal', p_half, coalesce(case when p_half = 1 then m.half1_ms else m.half2_ms end, 0),
          v_team, p_player, v_role, v_keeper, auth.uid())
  on conflict (id) do nothing;
  update matches set version = version + 1 where id = p_match;
end $$;

create or replace function public.admin_delete_goal(p_match uuid, p_event uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  perform require_admin();
  select * into m from matches where id = p_match for update;
  if m.status not in ('review', 'pending') then raise exception 'Sadece onay bekleyen maç düzenlenebilir' using errcode = 'P0001'; end if;
  update match_events set deleted_at = now() where id = p_event and match_id = p_match and kind = 'goal' and deleted_at is null;
  update matches set version = version + 1 where id = p_match;
end $$;

-- ---------- Sonuçlandırma ----------

create or replace function public.match_facts(p_match uuid)
returns table (goals_a int, goals_b int, ht_a int, ht_b int, first_scorer uuid)
language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where team = 'A')::int,
    count(*) filter (where team = 'B')::int,
    count(*) filter (where team = 'A' and half = 1)::int,
    count(*) filter (where team = 'B' and half = 1)::int,
    (select player_id from match_events
      where match_id = p_match and kind = 'goal' and deleted_at is null order by half, seq limit 1)
  from match_events where match_id = p_match and kind = 'goal' and deleted_at is null;
$$;

-- TypeScript'teki settleRule ile birebir aynı
create or replace function public.settle_rule(p_rule jsonb, ga int, gb int, ha int, hb int, p_first uuid, p_match uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare k text := p_rule ->> 'k'; o text; ft text; ht text; t int := ga + gb; won boolean; pg int;
begin
  ft := case when ga > gb then 'A' when ga < gb then 'B' else 'D' end;
  ht := case when ha > hb then 'A' when ha < hb then 'B' else 'D' end;
  case k
    when 'ms' then won := ft = (p_rule ->> 'o');
    when 'dc' then won := ft in (p_rule -> 'o' ->> 0, p_rule -> 'o' ->> 1);
    when 'ht' then won := ht = (p_rule ->> 'o');
    when 'h2' then
      won := (case when ga - ha > gb - hb then 'A' when ga - ha < gb - hb then 'B' else 'D' end) = (p_rule ->> 'o');
    when 'htft' then won := ht = (p_rule ->> 'ht') and ft = (p_rule ->> 'ft');
    when 'htou' then
      won := case when p_rule ->> 'side' = 'over' then ha + hb > (p_rule ->> 'line')::numeric else ha + hb < (p_rule ->> 'line')::numeric end;
    when 'ou' then
      won := case when p_rule ->> 'side' = 'over' then t > (p_rule ->> 'line')::numeric else t < (p_rule ->> 'line')::numeric end;
    when 'btts' then won := (ga > 0 and gb > 0) = (p_rule ->> 'yes')::boolean;
    when 'pg' then
      select count(*) into pg from match_events
        where match_id = p_match and kind = 'goal' and deleted_at is null and player_id = (p_rule ->> 'player')::uuid;
      won := (pg > 0) = (p_rule ->> 'yes')::boolean;
    when 'pgl' then
      select count(*) into pg from match_events
        where match_id = p_match and kind = 'goal' and deleted_at is null and player_id = (p_rule ->> 'player')::uuid;
      won := case when p_rule ->> 'side' = 'over' then pg > (p_rule ->> 'line')::numeric else pg < (p_rule ->> 'line')::numeric end;
    when 'fg' then
      if p_first is null then return 'void'; end if;
      won := p_first = (p_rule ->> 'player')::uuid;
    else raise exception 'Bilinmeyen bahis kuralı: %', k;
  end case;
  return case when won then 'won' else 'lost' end;
end $$;

create or replace function public.approve_match(p_match uuid, p_void_bets boolean default false, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare m matches; f record; s selections; b bets; v_res text; v_pay numeric;
begin
  perform require_admin();
  select * into m from matches where id = p_match for update;
  if m.id is null then raise exception 'Maç bulunamadı' using errcode = 'P0001'; end if;
  if m.status not in ('review', 'pending') then raise exception 'Bu maç onaylanamaz (%)', m.status using errcode = 'P0001'; end if;
  update matches set status = 'approved', decided_at = now(), decided_by = auth.uid(), bets_voided = p_void_bets,
    decision_note = p_note, submitted_at = coalesce(submitted_at, now()), version = version + 1 where id = p_match;
  if p_void_bets then
    update selections set result = 'void' where match_id = p_match;
    perform refund_match_bets(p_match, 'Bahisler admin tarafından iade edildi');
    return;
  end if;
  select * into f from match_facts(p_match);
  for s in select * from selections where match_id = p_match loop
    update selections set result = settle_rule(s.rule, f.goals_a, f.goals_b, f.ht_a, f.ht_b, f.first_scorer, p_match)
    where id = s.id;
  end loop;
  for b in select * from bets where match_id = p_match and status = 'open' order by created_at for update loop
    select result into v_res from selections where id = b.selection_id;
    if v_res = 'won' then
      v_pay := round(b.stake * b.odds, 2);
      update bets set status = 'won', payout = v_pay, settled_at = now() where id = b.id;
      perform ledger(b.user_id, v_pay, 'payout', b.id, p_match, 'Kazanan kupon');
    elsif v_res = 'void' then
      update bets set status = 'void', payout = b.stake, settled_at = now() where id = b.id;
      perform ledger(b.user_id, b.stake, 'refund', b.id, p_match, 'Bahis iade (sonuç oluşmadı)');
    else
      update bets set status = 'lost', payout = 0, settled_at = now() where id = b.id;
    end if;
  end loop;
end $$;

create or replace function public.reject_match(p_match uuid, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  perform require_admin();
  select * into m from matches where id = p_match for update;
  if m.status not in ('review', 'pending') then raise exception 'Bu maç reddedilemez (%)', m.status using errcode = 'P0001'; end if;
  update matches set status = 'rejected', decided_at = now(), decided_by = auth.uid(), bets_voided = true,
    decision_note = p_note, version = version + 1 where id = p_match;
  update selections set result = 'void' where match_id = p_match;
  perform refund_match_bets(p_match, 'Maç reddedildi, bahis iade');
end $$;

-- ---------- Bahis ----------

create or replace function public.place_bet(p_selection uuid, p_stake numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me profiles; s selections; m matches; v_bet uuid; nb numeric;
begin
  me := require_active();
  select * into s from selections where id = p_selection;
  if s.id is null then raise exception 'Seçenek bulunamadı' using errcode = 'P0001'; end if;
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

create or replace function public.cancel_bet(p_bet uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare b bets; m matches;
begin
  perform require_active();
  select * into b from bets where id = p_bet and user_id = auth.uid();
  if b.id is null then raise exception 'Kupon bulunamadı' using errcode = 'P0001'; end if;
  -- kilit sırası her yerde aynı: önce maç, sonra kupon, sonra bakiye
  select * into m from matches where id = b.match_id for share;
  select * into b from bets where id = p_bet for update;
  if m.status <> 'open' or b.status <> 'open' then raise exception 'Maç başladı, kupon iptal edilemez' using errcode = 'P0001'; end if;
  update bets set status = 'cancelled', settled_at = now() where id = p_bet;
  return ledger(b.user_id, b.stake, 'refund', b.id, b.match_id, 'Kupon iptal');
end $$;

-- Admin: tüm aktif hesaplara aynı anda coin
create or replace function public.admin_grant_all(p_amount numeric, p_note text)
returns integer language plpgsql security definer set search_path = public as $$
declare u uuid; n int := 0;
begin
  perform require_admin();
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'Geçersiz tutar' using errcode = 'P0001';
  end if;
  for u in select id from profiles where status = 'active' order by id for update loop
    perform ledger(u, p_amount, 'admin', null, null, coalesce(nullif(btrim(p_note), ''), 'Admin hediyesi'));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Admin: kasanın durumu
create or replace function public.admin_house_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform require_admin();
  select jsonb_build_object(
    'staked', coalesce(sum(stake) filter (where status in ('won', 'lost')), 0),
    'paid', coalesce(sum(payout) filter (where status = 'won'), 0),
    'open_stake', coalesce(sum(stake) filter (where status = 'open'), 0),
    'bets', count(*) filter (where status <> 'cancelled'),
    'coins_in_play', (select coalesce(sum(balance), 0) from profiles where status = 'active')
  ) into r from bets;
  return r;
end $$;

-- ---------- Okuma ----------

-- Onaylanmış tüm maçlar + olaylar (istatistik ve model için; satır limiti olmadan tek seferde)
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
  from matches m where m.status = 'approved' and (is_active() or auth.role() = 'service_role');
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
  group by p.id
  order by p.balance desc;
$$;

-- ---------- Güvenlik (RLS) ----------

alter table public.players enable row level security;
alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.match_events enable row level security;
alter table public.markets enable row level security;
alter table public.selections enable row level security;
alter table public.bets enable row level security;
alter table public.transactions enable row level security;

create policy players_read on public.players for select to authenticated using (is_active());
create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or is_active());
create policy matches_read on public.matches for select to authenticated using (is_active());
create policy events_read on public.match_events for select to authenticated using (is_active());
create policy markets_read on public.markets for select to authenticated using (is_active());
create policy selections_read on public.selections for select to authenticated using (is_active());
-- Başkalarının kuponları, maç başlayınca görünür (bahis sürerken sürü etkisi olmasın)
create policy bets_read on public.bets for select to authenticated using (
  user_id = auth.uid()
  or (is_active() and exists (select 1 from matches m where m.id = match_id and m.status <> 'open'))
);
create policy transactions_read on public.transactions for select to authenticated using (user_id = auth.uid());

-- Doğrudan yazma yok; sadece fonksiyonlar
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
-- Edge Function'lar okuma yapar (Supabase'de varsayılan olarak da vardır, burada açıkça yazıldı)
grant select on all tables in schema public to service_role;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.server_now() to anon, authenticated;
grant execute on function public.is_active(), public.is_admin() to authenticated;
grant execute on function
  public.admin_approve_user(uuid, uuid), public.admin_set_user_status(uuid, text), public.admin_link_player(uuid, uuid),
  public.admin_add_player(text), public.admin_update_player(uuid, text, boolean), public.admin_adjust_balance(uuid, numeric, text),
  public.cancel_match(uuid), public.start_match(uuid), public.set_clock(uuid, boolean), public.tick(uuid),
  public.record_goal(uuid, uuid, uuid, integer), public.swap_roles(uuid, uuid, text), public.undo_event(uuid, uuid),
  public.finish_early(uuid), public.resume_match(uuid), public.submit_match(uuid), public.admin_add_goal(uuid, uuid, smallint, uuid),
  public.admin_delete_goal(uuid, uuid), public.approve_match(uuid, boolean, text), public.reject_match(uuid, text),
  public.place_bet(uuid, numeric), public.cancel_bet(uuid), public.admin_grant_all(numeric, text), public.admin_house_stats(), public.approved_history(), public.get_leaderboard()
to authenticated;
grant execute on function public.svc_create_match(uuid, jsonb, jsonb, jsonb), public.approved_history() to service_role;

-- ---------- Canlı yayın ----------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.matches, public.match_events, public.bets, public.profiles, public.players, public.selections;
  end if;
end $$;

-- ---------- APK dağıtımı ----------
-- GitHub Actions her derlemede APK'yı ve version.json'u bu herkese açık klasöre yükler;
-- uygulama yeni sürüm olduğunda kullanıcıya haber verir.
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('app', 'app', true) on conflict (id) do nothing;
  end if;
end $$;
