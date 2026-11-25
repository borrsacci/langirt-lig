// Uçtan uca arayüz testi: birden çok kullanıcıyla tam lig akışı
import pg from 'pg';
import { chromium } from 'playwright-core';

const APP = 'http://127.0.0.1:3000';
const SHOTS = process.env.SHOTS ?? '/tmp/shots';
const db = new pg.Client({ host: '/tmp', port: 55432, user: 'postgres', database: 'e2e' });
await db.connect();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const errors = [];
async function user() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/WebSocket|realtime|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
  await page.goto(APP);
  return page;
}
let n = 0;
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, '0')}-${name}.png`, fullPage: false });
const click = (page, text, opts = {}) => page.getByRole('button', { name: text, exact: opts.exact ?? false }).first().click();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const toastSeen = async (page, re) => page.getByText(re).first().waitFor({ timeout: 8000 });

async function register(page, username, name, pw = 'sifre123') {
  await click(page, 'Hesap aç');
  await page.getByLabel('Kullanıcı adı').fill(username);
  await page.getByLabel('Adınız').fill(name);
  await page.getByLabel('Şifre', { exact: true }).fill(pw);
  await page.getByLabel('Şifre tekrar').fill(pw);
  await page.getByRole('button', { name: 'Hesap aç' }).last().click();
}
async function tab(page, name) {
  await page.locator('nav').getByRole('button', { name }).click();
  await wait(300);
}
async function confirmSheet(page, okText) {
  await page.getByRole('button', { name: okText, exact: true }).last().click();
}

try {
  // 1) İlk kullanıcı admin
  const okan = await user();
  await shot(okan, 'giris');
  await register(okan, 'okan', 'Okan');
  await okan.getByText('Yeni maç').waitFor();
  await shot(okan, 'admin-ilk-ekran');

  // 2) Diğerleri kayıt olur, onay bekler
  const others = {};
  for (const [u, nm] of [['caner', 'Caner'], ['burak', 'Burak'], ['tolga', 'Tolga'], ['sefa', 'Sefa']]) {
    others[u] = await user();
    await register(others[u], u, nm);
    await others[u].getByText('Onay bekleniyor').waitFor();
  }
  await shot(others.sefa, 'onay-bekleniyor');

  // 3) Admin onaylar
  await tab(okan, 'Profil');
  await okan.reload();
  await tab(okan, 'Profil');
  await okan.getByText('Admin paneli').click();
  await okan.getByRole('button', { name: /Kullanıcılar/ }).click();
  await shot(okan, 'admin-kullanici-onay');
  for (let i = 0; i < 4; i++) {
    await okan.getByRole('button', { name: 'Onayla', exact: true }).first().click();
    await toastSeen(okan, /onaylandı/);
    await wait(400);
  }
  for (const p of Object.values(others)) await click(p, 'Tekrar kontrol et');
  await others.caner.getByText('Yeni maç').waitFor();

  // 4) Kura ve bahsi açma
  const caner = others.caner;
  for (const nm of ['Okan', 'Caner', 'Burak', 'Tolga']) await caner.getByRole('button', { name: nm, exact: true }).click();
  await shot(caner, 'oyuncu-secimi');
  await click(caner, 'Kura çek');
  await wait(400);
  await shot(caner, 'kura-sonucu');
  await click(caner, 'Oranları çıkar, bahsi aç');
  await caner.getByText('Bahis açık').waitFor({ timeout: 15000 });
  await shot(caner, 'bulten');
  await caner.screenshot({ path: `${SHOTS}/${String(++n).padStart(2, '0')}-bulten-tam.png`, fullPage: true });

  const m = (await db.query(`select * from matches where status='open'`)).rows[0];
  const pid = Object.fromEntries((await db.query('select id, name from players')).rows.map((r) => [r.name, r.id]));
  const nameOf = Object.fromEntries(Object.entries(pid).map(([k, v]) => [v, k]));
  console.log('kadro: Mavi', nameOf[m.a_f], '(F)', nameOf[m.a_k], '(K) — Kırmızı', nameOf[m.b_f], '(F)', nameOf[m.b_k], '(K)');

  // 5) İzleyici Sefa bahis yapar
  const sefa = others.sefa;
  await sefa.reload();
  await sefa.getByText('Bahis açık').waitFor();
  await sefa.getByText('Maç Sonucu').locator('..').getByRole('button').first().click();
  await sefa.getByPlaceholder('Tutar').fill('50');
  await shot(sefa, 'kupon');
  await click(sefa, 'Kuponu onayla');
  await toastSeen(sefa, /Kupon alındı/);
  // aynı maça ikinci kupon: İY/MS
  await sefa.getByText('İlk Yarı / Maç Sonucu').locator('..').getByRole('button').first().click();
  await sefa.getByPlaceholder('Tutar').fill('10');
  await shot(sefa, 'kupon-iyms');
  await click(sefa, 'Kuponu onayla');
  await toastSeen(sefa, /Kupon alındı/);
  // geçersiz tutar
  await sefa.getByText(/Toplam Gol .* Alt\/Üst/).nth(1).locator('..').getByRole('button').last().click();
  await sefa.getByPlaceholder('Tutar').fill('1');
  await sefa.getByText(/En az 2 coin/).first().waitFor();
  await sefa.getByPlaceholder('Tutar').fill('20');
  await click(sefa, 'Kuponu onayla');
  await toastSeen(sefa, /Kupon alındı/);

  // 6) Maçtaki oyuncu (Okan) aleyhine bahis yapamaz
  await okan.reload();
  await okan.getByText('Bahis açık').waitFor();
  const okanTeam = [m.a_f, m.a_k].includes(pid.Okan) ? 'A' : 'B';
  await okan.getByText(/kendi takımının lehine olan bahisler, beraberlik ve rakibin golüne alt/).waitFor();
  const msBtns = okan.getByText('Maç Sonucu').locator('..').getByRole('button');
  const lockedIdx = okanTeam === 'A' ? 2 : 0;
  if (!(await msBtns.nth(lockedIdx).isDisabled())) throw new Error('aleyhe bahis butonu kilitli değil');
  if (await msBtns.nth(1).isDisabled()) throw new Error('beraberlik oyuncuya kapalı');
  await msBtns.nth(okanTeam === 'A' ? 0 : 2).click();
  await okan.getByPlaceholder('Tutar').fill('100');
  await click(okan, 'Kuponu onayla');
  await toastSeen(okan, /Kupon alındı/);
  await shot(okan, 'oyuncu-kilitli-bulten');

  // 7) Maç başlar
  await click(caner, 'Maçı başlat');
  await confirmSheet(caner, 'Başlat');
  await caner.getByText('Saati durdur').waitFor();
  const L = { AF: m.a_f, AK: m.a_k, BF: m.b_f, BK: m.b_k };
  const goalBtn = (id) => caner.getByRole('button', { name: new RegExp(`^${nameOf[id]}`) }).first();
  await goalBtn(L.AF).click(); await wait(700);
  await goalBtn(L.AF).click(); await wait(700);
  await goalBtn(L.BK).click(); await wait(700);
  await shot(caner, 'canli');
  // bahis kapandı mı: Sefa yeni kupon yapamaz
  await sefa.reload();
  await sefa.getByText('Goller').first().waitFor();
  await shot(sefa, 'izleyici-canli');

  // Mevki değişimi (Kırmızı)
  await caner.getByRole('button', { name: 'Mevki değiş' }).nth(1).click();
  await confirmSheet(caner, 'Değiştir');
  await caner.getByText('Kırmızı mevki değiştirdi').waitFor();
  await wait(500);
  await goalBtn(L.BK).click(); await wait(700); // artık forvet

  // süreyi bitir → son top
  await db.query(`update matches set clock_updated_at = clock_updated_at - interval '200 seconds' where id=$1`, [m.id]);
  await caner.getByText('Son top', { exact: true }).waitFor({ timeout: 8000 });
  await shot(caner, 'son-top');
  await goalBtn(L.AK).click();
  await caner.getByText(/yarıyı başlat/).waitFor();
  await shot(caner, 'devre-arasi');
  await click(caner, '2. yarıyı başlat');
  await wait(800);
  await goalBtn(L.AF).click(); await wait(700);
  await db.query(`update matches set clock_updated_at = clock_updated_at - interval '200 seconds' where id=$1`, [m.id]);
  await caner.getByText('Son top', { exact: true }).waitFor({ timeout: 8000 });
  await goalBtn(L.AF).click();
  await caner.getByRole('button', { name: 'Onaya gönder' }).waitFor();
  await shot(caner, 'mac-bitti');
  await click(caner, 'Onaya gönder');
  await toastSeen(caner, /Onaya gönderildi/);
  await wait(600);
  await shot(caner, 'onay-bekliyor-banner');

  // 8) Admin onaylar
  await okan.reload();
  await tab(okan, 'Profil');
  await okan.getByText('Admin paneli').click();
  await okan.getByRole('button', { name: /Maç onayı/ }).click();
  await okan.getByText('Onaya gönderildi').first().click();
  await okan.getByRole('button', { name: 'Onayla', exact: true }).waitFor();
  await shot(okan, 'admin-mac-onay');
  await okan.getByRole('button', { name: 'Onayla', exact: true }).click();
  await confirmSheet(okan, 'Onayla');
  await toastSeen(okan, /Maç onaylandı/);
  await wait(500);
  await shot(okan, 'admin-kasa');
  // herkese coin
  await okan.getByRole('button', { name: /Kullanıcılar/ }).click();
  await okan.getByPlaceholder('Tutar').fill('100');
  await okan.getByRole('button', { name: 'Herkese ver' }).click();
  await confirmSheet(okan, 'Ver');
  await toastSeen(okan, /5 hesaba 100 coin eklendi/);

  // 9) Sonuçlar
  await sefa.reload();
  await tab(sefa, 'Kuponlar');
  await click(sefa, 'Sonuçlanan');
  await wait(500);
  await shot(sefa, 'kuponlar-sonuc');
  await click(sefa, 'Herkes');
  await sefa.getByText('Okan').first().waitFor();
  await shot(sefa, 'kuponlar-herkes');
  await tab(sefa, 'İstatistik');
  await wait(500);
  await shot(sefa, 'istatistik');
  await click(sefa, 'Güç');
  await shot(sefa, 'guc');
  await click(sefa, 'Oyuncular');
  await sefa.getByRole('button', { name: /^1/ }).first().click();
  await wait(500);
  await shot(sefa, 'oyuncu-detay');
  await sefa.keyboard.press('Escape');
  await sefa.reload();
  await tab(sefa, 'Sıralama');
  await wait(500);
  await shot(sefa, 'siralama');
  await sefa.locator('li').filter({ hasText: 'Okan' }).click();
  await wait(600);
  await shot(sefa, 'kisi-kuponlari');
  await sefa.mouse.click(200, 60);
  await wait(400);
  await tab(sefa, 'Profil');
  await wait(500);
  await shot(sefa, 'profil');

  // Bakiye ve defter kontrolü
  const bal = (await db.query(`select p.display_name, p.balance, coalesce(sum(t.amount),0) s from profiles p left join transactions t on t.user_id=p.id group by p.id order by 1`)).rows;
  for (const r of bal) if (Number(r.balance) !== Number(r.s)) throw new Error('defter tutarsız ' + r.display_name);
  console.log('bakiyeler', bal.map((r) => `${r.display_name}=${r.balance}`).join(' '));
  const bets = (await db.query(`select p.display_name, b.status, b.stake, b.odds, b.payout from bets b join profiles p on p.id=b.user_id`)).rows;
  console.log('kuponlar', JSON.stringify(bets));
  for (const b of bets) {
    if (b.status === 'won' && Number(b.payout) !== Math.round(Number(b.stake) * Number(b.odds) * 100) / 100) throw new Error('ödeme yanlış');
  }
  if (bets.filter((b) => b.display_name === 'Sefa').length !== 3) throw new Error('aynı maça çoklu kupon olmadı');
  const score = Object.fromEntries((await db.query(`select team, count(*)::int c from match_events where match_id=$1 and kind='goal' and deleted_at is null group by team`, [m.id])).rows.map((r) => [r.team, r.c]));
  console.log('skor', JSON.stringify(score));
  // girilen goller: Mavi F, Mavi F, Kırmızı K, Kırmızı (değişim sonrası forvet), Mavi K (son top), Mavi F, Mavi F (son top)
  if (score.A !== 5 || score.B !== 2) throw new Error('skor yanlış: ' + JSON.stringify(score));
  const roles = (await db.query(`select team, role, last_ball from match_events where match_id=$1 and kind='goal' order by seq`, [m.id])).rows.map((r) => r.team + r.role + (r.last_ball ? '*' : '')).join(' ');
  if (roles !== 'AF AF BK BF AK* AF AF*') throw new Error('gol kayıtları yanlış: ' + roles);
} catch (e) {
  errors.push('TEST HATASI: ' + e.message);
} finally {
  console.log(errors.length ? 'HATALAR:\n' + errors.join('\n') : 'HATA YOK');
  await browser.close();
  await db.end();
}
