// Veritabanı entegrasyon testleri: gerçek Postgres üzerinde (Supabase auth taklidiyle)
// tüm para, yetki ve maç akışı kurallarını uçtan uca dener.
// Çalıştırmak için: PGTEST_HOST=/tmp PGTEST_PORT=55432 npm test
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveFacts } from '../supabase/functions/_shared/game.ts';
import { fitForLineup } from '../supabase/functions/_shared/model.ts';
import { priceMatch } from '../supabase/functions/_shared/pricing.ts';
import { settleRule } from '../supabase/functions/_shared/settle.ts';
import type { MatchEvent } from '../supabase/functions/_shared/types.ts';

const HOST = process.env.PGTEST_HOST;
const d = HOST ? describe : describe.skip;

let admin: pg.Client; // süper kullanıcı (test kurulumu)
let dbName = '';

async function connect(db: string) {
  const c = new pg.Client({ host: HOST, port: Number(process.env.PGTEST_PORT ?? 5432), user: 'postgres', database: db });
  await c.connect();
  return c;
}

async function as<T = any>(uid: string | 'service' | null, sql: string, params: unknown[] = [], client = admin): Promise<T[]> {
  await client.query('begin');
  try {
    if (uid === 'service') {
      await client.query(`set local role service_role; select set_config('request.jwt.claim.role','service_role',true)`);
    } else if (uid) {
      await client.query(`set local role authenticated`);
      await client.query(`select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)`, [uid]);
    } else {
      await client.query(`set local role anon`);
    }
    const r = await client.query(sql, params);
    await client.query('commit');
    return r.rows;
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

async function signup(username: string, display: string) {
  const id = randomUUID();
  await admin.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1,$2,$3)`, [
    id, `${username}@users.langirt.app`, { username, display_name: display },
  ]);
  return id;
}

const bal = async (uid: string) => Number((await admin.query('select balance from profiles where id=$1', [uid])).rows[0].balance);
const one = async <T = any>(sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows[0] as T;

/** Saati ileri sarar (sunucu zamanını taklit): çalışan saatin başlangıcını geriye kaydırır */
async function advanceClock(matchId: string, ms: number) {
  await admin.query(`update matches set clock_updated_at = clock_updated_at - make_interval(secs => $2::float8/1000) where id=$1`, [matchId, ms]);
}

async function createMatch(creator: string, lineup: { AF: string; AK: string; BF: string; BK: string }) {
  const names = Object.fromEntries((await admin.query('select id,name from players')).rows.map((r) => [r.id, r.name]));
  const pr = priceMatch(fitForLineup([], lineup), lineup, (id) => names[id]);
  const rows = await as('service', 'select svc_create_match($1,$2,$3,$4) as id', [creator, lineup, JSON.stringify(pr.markets), { probs: pr.probs }]);
  return rows[0].id as string;
}

async function sel(matchId: string, market: string, code: string) {
  return one<{ id: string; odds: string }>(
    `select s.id, s.odds from selections s join markets m on m.id=s.market_id where s.match_id=$1 and m.code=$2 and s.code=$3`,
    [matchId, market, code],
  );
}

async function expectErr(p: Promise<unknown>, msg: RegExp) {
  await expect(p).rejects.toThrow(msg);
}

let A: string, U2: string, U3: string, U4: string, U5: string, PEND: string;
let P: Record<string, string> = {};

d('veritabanı kuralları', () => {
  beforeAll(async () => {
    admin = await connect('postgres');
    dbName = `t_${Date.now()}`;
    await admin.query(`create database ${dbName}`);
    await admin.end();
    admin = await connect(dbName);
    await admin.query(readFileSync('tests/db/supabase_stub.sql', 'utf8'));
    for (const f of readdirSync('supabase/migrations').sort()) await admin.query(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  });
  afterAll(async () => {
    await admin?.end();
    const c = await connect('postgres');
    await c.query(`drop database if exists ${dbName}`);
    await c.end();
  });

  it('kayıt: ilk hesap admin olur, diğerleri onay bekler', async () => {
    A = await signup('okan', 'Okan');
    expect(await one('select is_admin, status, balance::float, player_id is not null as p from profiles where id=$1', [A]))
      .toEqual({ is_admin: true, status: 'active', balance: 1000, p: true });
    U2 = await signup('caner', 'Caner');
    expect(await one('select is_admin, status, balance::float from profiles where id=$1', [U2])).toEqual({ is_admin: false, status: 'pending', balance: 0 });
    // onaysız kullanıcı veri göremez, işlem yapamaz
    expect(await as(U2, 'select * from players')).toHaveLength(0);
    expect(await as(U2, 'select id from profiles')).toEqual([{ id: U2 }]);
    expect((await as(U2, 'select approved_history() as h'))[0].h).toEqual([]);
    // admin onaylar → 1000 coin; iki kez onay çift bonus vermez
    await as(A, 'select admin_approve_user($1, null)', [U2]);
    await as(A, 'select admin_set_user_status($1, $2)', [U2, 'active']);
    expect(await bal(U2)).toBe(1000);
    U3 = await signup('burak', 'Burak');
    U4 = await signup('tolga', 'Tolga');
    U5 = await signup('sefa', 'Sefa'); // izleyici
    PEND = await signup('yabanci', 'Yabancı');
    for (const u of [U3, U4, U5]) await as(A, 'select admin_approve_user($1, null)', [u]);
    for (const r of (await admin.query('select p.display_name, p.player_id from profiles p')).rows) P[r.display_name] = r.player_id;
    expect(Object.values(P).filter(Boolean)).toHaveLength(5);
  });

  it('yetki: admin olmayan admin işlemi yapamaz, tablolara doğrudan yazılamaz', async () => {
    await expectErr(as(U2, 'select admin_adjust_balance($1, 5000, null)', [U2]), /sadece admin/);
    await expectErr(as(U2, 'select admin_approve_user($1, null)', [PEND]), /sadece admin/);
    await expectErr(as(U2, `update profiles set balance = 99999 where id = $1`, [U2]), /permission denied/);
    await expectErr(as(U2, `insert into transactions (user_id, amount, balance_after, kind) values ($1, 1, 1, 'admin')`, [U2]), /permission denied/);
    await expectErr(as(null, `select place_bet($1, 2)`, [randomUUID()]), /permission denied/);
    await expectErr(as(U2, `select svc_create_match($1,'{}','[]','{}')`, [U2]), /permission denied/);
    await expectErr(as(PEND, `select place_bet($1, 2)`, [randomUUID()]), /onaylanmadı/);
    expect(await as(null, `select username_available('okan') as a`)).toEqual([{ a: false }]);
    // admin kendini kapatamaz; ikinci admin olamaz
    await expectErr(as(A, 'select admin_set_user_status($1, $2)', [A, 'disabled']), /Kendi/);
  });

  let M1: string;
  it('maç açılır, ikinci açık maç engellenir', async () => {
    M1 = await createMatch(U2, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    expect((await one('select status from matches where id=$1', [M1])).status).toBe('open');
    await expectErr(createMatch(U2, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Sefa'] }), /Zaten açık/);
    expect(Number((await one('select count(*) from selections where match_id=$1', [M1])).count)).toBeGreaterThan(20);
  });

  it('bahis kuralları', async () => {
    const msA = await sel(M1, 'ms', '1');
    const msB = await sel(M1, 'ms', '2');
    const msX = await sel(M1, 'ms', 'X');
    const ouCode = (await one(`select code from markets where match_id=$1 and code like 'ou_%' order by sort limit 1 offset 1`, [M1])).code;
    const btts = await sel(M1, ouCode, 'O'); // nötr pazar (alt/üst)
    await expectErr(as(U5, 'select place_bet($1, 1.99)', [msA.id]), /En az/);
    await expectErr(as(U5, 'select place_bet($1, 2.001)', [msA.id]), /ondalık/);
    await expectErr(as(U5, 'select place_bet($1, 1000.01)', [msA.id]), /Yetersiz/);
    // Okan (A takımı forvet): kendi lehine olanlar serbest, aleyhine/nötr yasak
    await as(A, 'select place_bet($1, 100)', [msA.id]);
    await as(A, 'select place_bet($1, 50)', [(await sel(M1, 'dc', '1X')).id]);
    await as(A, 'select place_bet($1, 10)', [(await sel(M1, `pg_${P['Caner']}`, 'Y')).id]);
    await as(A, 'select place_bet($1, 5)', [(await sel(M1, 'tg_B', 'U')).id]); // rakip takımın golüne alt
    await as(A, 'select place_bet($1, 5)', [(await sel(M1, `pgl_${P['Burak']}`, 'U')).id]); // rakip oyuncunun golüne alt
    await expectErr(as(A, 'select place_bet($1, 5)', [(await sel(M1, 'tg_B', 'O')).id]), /kendi lehinize/); // rakibe üst yok
    await expectErr(as(A, 'select place_bet($1, 5)', [(await sel(M1, `pgl_${P['Burak']}`, 'O')).id]), /kendi lehinize/);
    await expectErr(as(A, 'select place_bet($1, 5)', [(await sel(M1, 'tg_A', 'U')).id]), /kendi lehinize/); // kendi takımına alt yok
    await expectErr(as(A, 'select place_bet($1, 10)', [msB.id]), /kendi lehinize/);
    await as(A, 'select place_bet($1, 10)', [msX.id]); // beraberlik oyunculara açık
    await expectErr(as(A, 'select place_bet($1, 10)', [btts.id]), /kendi lehinize/);
    await expectErr(as(A, 'select place_bet($1, 10)', [(await sel(M1, `pg_${P['Okan']}`, 'N')).id]), /kendi lehinize/);
    await expectErr(as(U3, 'select place_bet($1, 10)', [msA.id]), /kendi lehinize/); // Burak B takımında
    // izleyici her şeye oynayabilir
    for (const s of [msA, msB, msX, btts]) await as(U5, 'select place_bet($1, 25)', [s.id]);
    await as(U5, 'select place_bet($1, 2)', [(await sel(M1, 'fg', P['Tolga'])).id]);
    expect(await bal(A)).toBe(820);
    expect(await bal(U5)).toBe(898);
    // kupon iptali: maç başlamadan
    const [{ place_bet: r }] = await as(U5, 'select place_bet($1, 40)', [msA.id]);
    await as(U5, 'select cancel_bet($1)', [r.bet_id]);
    expect(await bal(U5)).toBe(898);
    await expectErr(as(U2, 'select cancel_bet($1)', [r.bet_id]), /bulunamadı/);
    // başkasının kuponu bahis açıkken görünmez
    expect(await as(U2, 'select * from bets where user_id=$1', [U5])).toHaveLength(0);
  });

  it('başlat: bahis kapanır, yetkisiz kişi maçı yönetemez', async () => {
    await expectErr(as(U5, 'select start_match($1)', [M1]), /sadece maçta oynayanlar/);
    await as(U3, 'select start_match($1)', [M1]); // oyunculardan biri başlatabilir
    await expectErr(as(U5, 'select place_bet($1, 10)', [(await sel(M1, 'ms', '1')).id]), /kapandı/);
    expect((await as(U2, 'select * from bets where user_id=$1', [U5])).length).toBe(6); // iptal edilen dahil
    const b = await one(`select id from bets where user_id=$1 and status='open' limit 1`, [U5]);
    await expectErr(as(U5, 'select cancel_bet($1)', [b.id]), /iptal edilemez/);
  });

  it('canlı maç: goller, mevki değişimi, son top, devre, geri alma', async () => {
    const goal = (uid: string, player: string, rem?: number, ev = randomUUID()) =>
      as(uid, 'select (record_goal($1,$2,$3,$4)).*', [M1, ev, player, rem ?? null]).then((r) => r[0]);
    await expectErr(goal(U5, P['Okan']), /sadece maçta oynayanlar/);
    await expectErr(goal(U2, P['Sefa']), /maçta değil/);
    await advanceClock(M1, 30_000);
    const ev1 = randomUUID();
    await goal(U2, P['Okan'], undefined, ev1);
    await goal(U2, P['Okan'], undefined, ev1); // aynı istek iki kez → tek gol
    expect(Number((await one(`select count(*) from match_events where match_id=$1 and kind='goal'`, [M1])).count)).toBe(1);
    const e1 = await one('select * from match_events where id=$1', [ev1]);
    expect(e1).toMatchObject({ team: 'A', role: 'F', keeper_id: P['Tolga'], last_ball: false, half: 1 });
    expect(e1.clock_ms).toBeGreaterThanOrEqual(30_000);
    expect(e1.clock_ms).toBeLessThan(32_000);
    // mevki değişimi: bir kez
    await as(U2, 'select swap_roles($1,$2,$3)', [M1, randomUUID(), 'B']);
    await expectErr(as(U2, 'select swap_roles($1,$2,$3)', [M1, randomUUID(), 'B']), /hakkını kullandı/);
    await advanceClock(M1, 10_000);
    const g2 = randomUUID();
    await goal(U2, P['Tolga'], undefined, g2); // Tolga artık forvet
    expect(await one('select team, role, keeper_id from match_events where id=$1', [g2])).toEqual({ team: 'B', role: 'F', keeper_id: P['Caner'] });
    // saat duraklat / devam
    await as(U2, 'select set_clock($1,false)', [M1]);
    const paused = await one('select clock_remaining_ms from matches where id=$1', [M1]);
    await advanceClock(M1, 60_000); // duraklatılmışken zaman geçmez
    await as(U2, 'select set_clock($1,true)', [M1]);
    expect((await one('select clock_remaining_ms from matches where id=$1', [M1])).clock_remaining_ms).toBe(paused.clock_remaining_ms);
    // süre biter → son top
    await advanceClock(M1, 200_000);
    await as(U2, 'select tick($1)', [M1]);
    expect(await one('select last_ball, clock_running, clock_remaining_ms from matches where id=$1', [M1]))
      .toEqual({ last_ball: true, clock_running: false, clock_remaining_ms: 0 });
    await expectErr(as(U2, 'select undo_event($1,$2)', [M1, randomUUID()]), /bulunamadı/);
    // son top golü yarıyı bitirir, saat sıfırlanır
    const g3 = randomUUID();
    await goal(U2, P['Burak'], 0, g3);
    expect(await one('select half, last_ball, clock_running, clock_remaining_ms, half1_ms from matches where id=$1', [M1]))
      .toEqual({ half: 2, last_ball: false, clock_running: false, clock_remaining_ms: 180000, half1_ms: 180000 });
    // yarıyı bitiren gol geri alınabilir (ikinci yarı başlamadıysa)
    await as(U2, 'select undo_event($1,$2)', [M1, g3]);
    expect(await one('select half, last_ball from matches where id=$1', [M1])).toEqual({ half: 1, last_ball: true });
    await goal(U2, P['Burak'], 0);
    // 2. yarı
    await as(U2, 'select set_clock($1,true)', [M1]);
    await advanceClock(M1, 50_000);
    await goal(U2, P['Caner']);
    // ağ gecikmesi: süre bitiminden hemen sonra gelen, ekranda süre varken basılmış gol son top sayılmaz
    await advanceClock(M1, 131_000);
    const late = randomUUID();
    await goal(U2, P['Okan'], 400, late);
    expect(await one('select last_ball, ends_half from match_events where id=$1', [late])).toEqual({ last_ball: false, ends_half: false });
    expect((await one('select status, last_ball from matches where id=$1', [M1]))).toEqual({ status: 'live', last_ball: true });
    // son top → maç biter → kontrol ekranı
    const fin = randomUUID();
    await goal(U2, P['Okan'], 0, fin);
    expect((await one('select status, half2_ms from matches where id=$1', [M1]))).toEqual({ status: 'review', half2_ms: 180000 });
    await as(U2, 'select undo_event($1,$2)', [M1, fin]);
    expect((await one('select status, last_ball from matches where id=$1', [M1]))).toEqual({ status: 'live', last_ball: true });
    await goal(U2, P['Okan'], 0, randomUUID());
    await expectErr(as(U5, 'select submit_match($1)', [M1]), /sadece maçta oynayanlar/);
    await as(U2, 'select submit_match($1)', [M1]);
    expect((await one('select status from matches where id=$1', [M1])).status).toBe('pending');
    // onay beklerken istatistiklere girmez
    expect((await as(U2, 'select approved_history() as h'))[0].h).toEqual([]);
  });

  it('admin düzeltip onaylar: tüm kuponlar TS kurallarıyla birebir aynı sonuçlanır', async () => {
    // admin bir gol ekler, birini siler
    const extra = randomUUID();
    await as(A, 'select admin_add_goal($1,$2,$3::smallint,$4)', [M1, extra, 2, P['Caner']]);
    await as(A, 'select admin_delete_goal($1,$2)', [M1, extra]);
    await expectErr(as(U2, 'select approve_match($1,false,null)', [M1]), /sadece admin/);
    const before: Record<string, number> = {};
    for (const u of [A, U2, U3, U4, U5]) before[u] = await bal(u);
    await as(A, 'select approve_match($1,false,$2)', [M1, 'tamam']);
    await expectErr(as(A, 'select approve_match($1,false,null)', [M1]), /onaylanamaz/);

    const events = (await admin.query('select * from match_events where match_id=$1', [M1])).rows.map((e) => ({ ...e, seq: Number(e.seq), deleted_at: e.deleted_at })) as MatchEvent[];
    const facts = deriveFacts(events);
    expect([facts.goalsA, facts.goalsB]).toEqual([4, 2]); // A: Okan 3 + Caner 1 ; B: Tolga 1 + Burak 1 (ilk yarı son top)
    expect([facts.htA, facts.htB]).toEqual([1, 2]);
    expect(facts.firstScorer).toBe(P['Okan']);
    const sels = (await admin.query('select rule, result from selections where match_id=$1', [M1])).rows;
    for (const s of sels) expect(s.result).toBe(settleRule(s.rule, facts));
    // ödemeler
    const bets = (await admin.query('select b.*, s.result from bets b join selections s on s.id=b.selection_id where b.match_id=$1', [M1])).rows;
    const expected = { ...before };
    for (const b of bets) {
      if (b.status === 'cancelled') continue;
      expect(b.status).toBe(b.result);
      if (b.result === 'won') expected[b.user_id] += Math.round(Number(b.stake) * Number(b.odds) * 100) / 100;
      if (b.result === 'void') expected[b.user_id] += Number(b.stake);
    }
    // maç ödülleri: Mavi (Okan, Caner) 4-2 kazandı → 30'ar; Kırmızı (Burak, Tolga) → 10'ar; izleyici 0
    expected[A] += 30;
    expected[U2] += 30;
    expected[U3] += 10;
    expected[U4] += 10;
    for (const u of Object.keys(expected)) expect(await bal(u)).toBeCloseTo(expected[u], 2);
    const rw = await admin.query(`select count(*)::int c, sum(amount)::float s from transactions where kind='reward' and match_id=$1`, [M1]);
    expect(rw.rows[0]).toEqual({ c: 4, s: 80 });
    // istatistiğe girdi
    const h = (await as(U2, 'select approved_history() as h'))[0].h;
    expect(h).toHaveLength(1);
    expect(h[0].events.filter((e: any) => e.kind === 'goal')).toHaveLength(6);
  });

  it('defter tutarlılığı: her bakiye = hareketlerin toplamı', async () => {
    const r = await admin.query(`select p.id, p.balance, coalesce(sum(t.amount),0) s from profiles p left join transactions t on t.user_id=p.id group by p.id`);
    for (const x of r.rows) expect(Number(x.balance)).toBeCloseTo(Number(x.s), 2);
    const last = await admin.query(`select distinct on (user_id) user_id, balance_after from transactions order by user_id, id desc`);
    for (const x of last.rows) expect(Number(x.balance_after)).toBeCloseTo(await bal(x.user_id), 2);
  });

  it('iptal ve ret: tüm bahisler iade', async () => {
    const M2 = await createMatch(A, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    const b0 = await bal(U5);
    await as(U5, 'select place_bet($1, 77.5)', [(await sel(M2, 'ms', '1')).id]);
    await expectErr(as(U5, 'select cancel_match($1)', [M2]), /yetkiniz yok/); // izleyici iptal edemez
    await as(U4, 'select cancel_match($1)', [M2]); // maçtaki oyuncu, başlamadan iptal edebilir
    expect(await bal(U5)).toBeCloseTo(b0, 2);
    const M3 = await createMatch(A, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    await as(U5, 'select place_bet($1, 33)', [(await sel(M3, 'ms', '2')).id]);
    await as(U2, 'select start_match($1)', [M3]);
    await expectErr(as(U2, 'select cancel_match($1)', [M3]), /sadece admin/);
    await as(U2, 'select finish_early($1)', [M3]);
    await as(U2, 'select resume_match($1)', [M3]);
    expect((await one('select status from matches where id=$1', [M3])).status).toBe('live');
    await as(U2, 'select finish_early($1)', [M3]);
    await as(U2, 'select submit_match($1)', [M3]);
    await as(A, 'select reject_match($1, $2)', [M3, 'yanlış kayıt']);
    expect(await bal(U5)).toBeCloseTo(b0, 2);
    expect((await admin.query(`select count(*)::int c from transactions where kind='reward' and match_id=$1`, [M3])).rows[0].c).toBe(0); // reddedilen maça ödül yok
    expect((await one(`select count(*) from bets where match_id=$1 and status='void'`, [M3])).count).toBe('1');
  });

  it('eşzamanlılık: "Başlat" ile aynı anda gelen bahis reddedilir', async () => {
    const M4 = await createMatch(A, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    const s = await sel(M4, 'ms', '1');
    const c2 = await connect(dbName);
    await admin.query('begin');
    await admin.query(`set local role authenticated`);
    await admin.query(`select set_config('request.jwt.claim.sub',$1,true)`, [U2]);
    await admin.query('select start_match($1)', [M4]);
    const betP = as(U5, 'select place_bet($1, 5)', [s.id], c2);
    await new Promise((r) => setTimeout(r, 300));
    await admin.query('commit');
    await expectErr(betP, /kapandı/);
    await c2.end();
    await as(A, 'select cancel_match($1)', [M4]);
  });

  it('kasa özeti ve herkese coin', async () => {
    const M5 = await createMatch(A, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    const s = await sel(M5, 'ms', '1');
    const b0 = await bal(U5);
    const [{ place_bet: r }] = await as(U5, 'select place_bet($1, 33.33)', [s.id]);
    expect(await bal(U5)).toBeCloseTo(b0 - 33.33, 2);
    await as(U5, 'select cancel_bet($1)', [r.bet_id]); // iptalde tutarın tamamı iade
    expect(await bal(U5)).toBeCloseTo(b0, 2);
    await as(A, 'select cancel_match($1)', [M5]);
    const hs = (await as(A, 'select admin_house_stats() as h'))[0].h;
    expect(Number(hs.bets)).toBeGreaterThan(0);
    await expectErr(as(U2, 'select admin_house_stats()'), /sadece admin/);
    await expectErr(as(U2, 'select admin_grant_all(10, null)'), /sadece admin/);
    const before = await bal(U2);
    const n = (await as(A, 'select admin_grant_all(250, $1) as n', ['Bayram']))[0].n;
    expect(n).toBe(5);
    expect(await bal(U2)).toBeCloseTo(before + 250, 2);
    await expectErr(as(A, 'select admin_grant_all(-5, null)'), /Geçersiz/);
  });

  it('başkalarının kuponları maç başladıktan sonra görünür', async () => {
    const all = await as(U2, 'select user_id, status from bets');
    expect(all.some((b: any) => b.user_id === U5)).toBe(true);
  });

  it('maçta oynamayan kişi (kurayı çekse bile) maçı yönetemez', async () => {
    // Sefa (U5) kurayı çekip bahsi açıyor ama maçta değil
    const M6 = await createMatch(U5, { AF: P['Okan'], AK: P['Caner'], BF: P['Burak'], BK: P['Tolga'] });
    await expectErr(as(U5, 'select start_match($1)', [M6]), /sadece/);
    await expectErr(as(U5, 'select cancel_match($1)', [M6]), /yetkiniz yok/);
    await as(U3, 'select start_match($1)', [M6]); // maçtaki oyuncu başlatır
    await expectErr(as(U5, 'select (record_goal($1,$2,$3,null)).id', [M6, randomUUID(), P['Okan']]), /sadece/);
    await expectErr(as(U5, 'select swap_roles($1,$2,$3)', [M6, randomUUID(), 'A']), /sadece/);
    await expectErr(as(U5, 'select finish_early($1)', [M6]), /sadece/);
    await as(U4, 'select (record_goal($1,$2,$3,null)).id', [M6, randomUUID(), P['Okan']]); // oyuncu girebilir
    await as(A, 'select (record_goal($1,$2,$3,null)).id', [M6, randomUUID(), P['Burak']]); // admin girebilir
    await as(A, 'select cancel_match($1)', [M6]);
  });

  it('sıralama tablosu', async () => {
    const lb = await as(U2, 'select * from get_leaderboard()');
    expect(lb.length).toBe(5);
    const s = lb.find((x: any) => x.user_id === U5);
    expect(Number(s.profit)).toBeCloseTo(Number(s.returned) - Number(s.staked), 2);
    expect(lb.map((x: any) => Number(x.balance))).toEqual([...lb.map((x: any) => Number(x.balance))].sort((a, b) => b - a));
  });
});
