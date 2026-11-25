-- =====================================================================
-- 1) Maç ödülleri: onaylanan her maçta oynayan 4 kişiye 10 coin;
--    beraberlikte herkese +15, galibiyette kazanan iki oyuncuya +20.
-- 2) Takım toplam golü alt/üst bahsi ('tg' kuralı).
-- Mevcut verilere dokunmaz.
-- =====================================================================

alter table public.transactions drop constraint if exists transactions_kind_check;
alter table public.transactions add constraint transactions_kind_check
  check (kind in ('signup', 'bet', 'payout', 'refund', 'admin', 'reward'));

-- TypeScript'teki settleRule ile birebir aynı
create or replace function public.settle_rule(p_rule jsonb, ga int, gb int, ha int, hb int, p_first uuid, p_match uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare k text := p_rule ->> 'k'; o text; ft text; ht text; t int := ga + gb; won boolean; pg int; tg int;
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
    when 'tg' then
      tg := case when p_rule ->> 'team' = 'A' then ga else gb end;
      won := case when p_rule ->> 'side' = 'over' then tg > (p_rule ->> 'line')::numeric else tg < (p_rule ->> 'line')::numeric end;
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

-- Maçta oynayan oyunculara ödül (hesabı olan ve aktif olanlara)
create or replace function public.pay_match_rewards(p_match uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m matches; f record; w text; pid uuid; team text; u uuid; amt numeric; note text;
begin
  select * into m from matches where id = p_match;
  select * into f from match_facts(p_match);
  w := case when f.goals_a > f.goals_b then 'A' when f.goals_a < f.goals_b then 'B' else 'D' end;
  for pid, team in select * from (values (m.a_f, 'A'), (m.a_k, 'A'), (m.b_f, 'B'), (m.b_k, 'B')) v(p, t) loop
    select id into u from profiles where player_id = pid and status = 'active';
    if u is null then continue; end if;
    if w = 'D' then amt := 25; note := 'Maç ödülü: katılım 10 + beraberlik 15';
    elsif w = team then amt := 30; note := 'Maç ödülü: katılım 10 + galibiyet 20';
    else amt := 10; note := 'Maç ödülü: katılım 10';
    end if;
    perform ledger(u, amt, 'reward', null, p_match, note);
  end loop;
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
  -- Oynayanların ödülü: maç istatistiklere girdiği her durumda (bahisler iade edilse de)
  perform pay_match_rewards(p_match);
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

revoke execute on function public.pay_match_rewards(uuid) from public, anon, authenticated;
