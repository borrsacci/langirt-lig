-- Maçı (saat, gol, mevki değişimi, bitirme, onaya gönderme, başlamadan iptal) sadece
-- maçta oynayan 4 kişi ve admin yönetebilir. Kurayı çeken kişi maçta değilse yönetemez.
create or replace function public.can_control(m matches) returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or (is_active() and exists (
    select 1 from profiles p
    where p.id = auth.uid() and p.player_id in (m.a_f, m.a_k, m.b_f, m.b_k)));
$$;
revoke execute on function public.can_control(matches) from public, anon, authenticated;

-- Hata mesajı yeni kurala göre
create or replace function public.lock_controlled(p_match uuid, p_statuses text[]) returns matches
language plpgsql security definer set search_path = public as $$
declare m matches;
begin
  perform require_active();
  m := normalize_clock(p_match);
  if m.id is null then raise exception 'Maç bulunamadı' using errcode = 'P0001'; end if;
  if not can_control(m) then raise exception 'Bu maçı sadece maçta oynayanlar veya admin yönetebilir' using errcode = 'P0001'; end if;
  if not (m.status = any (p_statuses)) then raise exception 'Maç bu işlem için uygun durumda değil (%)', m.status using errcode = 'P0001'; end if;
  return m;
end $$;
revoke execute on function public.lock_controlled(uuid, text[]) from public, anon, authenticated;
