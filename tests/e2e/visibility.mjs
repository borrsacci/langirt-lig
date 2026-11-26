// Uçtan uca: admin bir kullanıcıyı "Hiçbir maçı görmez" yapar; o kullanıcı açık maçı, kurayı,
// istatistikleri ve diğer kullanıcıları göremez.
import { chromium } from 'playwright-core';

const API = 'http://127.0.0.1:54321';
const ANON = process.env.ANON;
const errors = [];
const check = (c, m) => { if (!c) errors.push(m); };
async function call(path, token, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token ?? ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(path + ': ' + t);
  return t ? JSON.parse(t) : null;
}
const signup = async (u) => {
  const j = await call('/auth/v1/signup', null, { email: `${u}@users.langirt.app`, password: 'sifre123', data: { username: u, display_name: u[0].toUpperCase() + u.slice(1) } });
  return { tok: j.access_token, id: j.user.id };
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-sandbox'] });
const page = async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await p.goto('http://127.0.0.1:3000');
  return p;
};
const login = async (p, u) => {
  await p.getByLabel('Kullanıcı adı').fill(u);
  await p.getByLabel('Şifre').fill('sifre123');
  await p.getByRole('button', { name: 'Giriş yap' }).last().click();
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const admin = await signup('okan');
  const U = {};
  for (const u of ['caner', 'burak', 'tolga', 'patron']) {
    U[u] = await signup(u);
    await call('/rest/v1/rpc/admin_approve_user', admin.tok, { p_user: U[u].id, p_player: null });
  }
  const players = await (await fetch(`${API}/rest/v1/players?select=id,name`, { headers: { apikey: ANON, Authorization: `Bearer ${admin.tok}` } })).json();
  const pid = Object.fromEntries(players.map((p) => [p.name, p.id]));

  // admin arayüzden Patron'u kısıtlar
  const a = await page();
  await login(a, 'okan');
  await a.locator('nav').getByRole('button', { name: 'Profil' }).click();
  await a.getByText('Admin paneli').click();
  await a.getByRole('button', { name: /Kullanıcılar/ }).click();
  await a.getByRole('button', { name: /Patron/ }).click();
  await a.getByRole('button', { name: 'Hiçbir maçı' }).click();
  await a.screenshot({ path: '/tmp/shots/v-admin-erisim.png' });
  await a.getByRole('button', { name: 'Erişimi kaydet' }).click();
  await a.getByText('Erişim kaydedildi').waitFor();
  await a.mouse.click(200, 60);
  await wait(500);
  await a.getByText('Maçları görmez').waitFor();
  await a.screenshot({ path: '/tmp/shots/v-admin-liste.png' });

  // bahis açık bir maç var
  await call('/functions/v1/create-match', U.caner.tok, { lineup: { AF: pid.Okan, AK: pid.Caner, BF: pid.Burak, BK: pid.Tolga } });

  // Patron hiçbir şey göremez
  const p = await page();
  await login(p, 'patron');
  await p.getByText('Henüz maç yok').waitFor();
  check(!(await p.getByText('Yeni maç').count()), 'kısıtlı kullanıcı kura ekranını görüyor');
  check(!(await p.getByText('Bahis açık').count()), 'kısıtlı kullanıcı açık maçı görüyor');
  check(!(await p.getByText('Bildirimler').count()), 'kısıtlı kullanıcı bildirim ayarını görüyor');
  await p.screenshot({ path: '/tmp/shots/v-kisitli-mac.png' });
  await p.locator('nav').getByRole('button', { name: 'Sıralama' }).click();
  await wait(500);
  check((await p.locator('li').count()) === 1, 'kısıtlı kullanıcı diğerlerini sıralamada görüyor');
  await p.locator('nav').getByRole('button', { name: 'Profil' }).click();
  await wait(300);
  check(!(await p.getByText('Admin paneli').count()), 'admin paneli görünüyor');
  check(!(await p.getByText(/görünürlük|Erişim/i).count()), 'erişim ayarı kişiye görünüyor');

  // normal kullanıcı (Tolga) maçı görür
  const t = await page();
  await login(t, 'tolga');
  await t.getByText('Bahis açık').waitFor();
} catch (e) {
  errors.push('TEST HATASI: ' + e.message);
} finally {
  console.log(errors.length ? 'HATALAR:\n' + errors.join('\n') : 'HATA YOK');
  await browser.close();
}
