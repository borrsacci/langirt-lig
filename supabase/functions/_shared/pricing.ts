// Oran hesaplama
// ==============
// 1) Modelden 4 slotun gol hızı gelir (λ_AF, λ_AK, λ_BF, λ_BK).
// 2) Bir yarı = 180 sn süre + "son top". Süre içinde her takımın golü Poisson(180·λ_takım);
//    süre bitince son topu A takımı p = λ_A/(λ_A+λ_B) olasılıkla atar. Bu, bir yarının
//    skor dağılımını TAM olarak verir (simülasyon değil, kesin hesap).
// 3) Maç = iki bağımsız yarının toplamı (konvolüsyon). Tüm pazarlar bu birleşik skor
//    dağılımından okunur; böylece oranlar birbirleriyle tutarlıdır (ör. 1X = 1 + X).
// 4) Adil olasılığa "kasa payı" eklenir. Güç (power) yöntemi kullanılır: marj, iddaa ve
//    gerçek bahis şirketlerindeki gibi favoriden çok sürprizlere yüklenir
//    (favori-sürpriz eğilimi). Oranlar her zaman aşağı yuvarlanır.
// 5) %95'ten olası sonuçlar bahse kapatılır (1,05 altı oranlar bedava para olurdu).

import { slotPredictive, slotRates, type ModelParams } from './model.ts';
import { mulberry32, normal } from './rng.ts';
import { type BetRule, HALF_MS, type Lineup, type Slot, type Team, SLOTS } from './types.ts';

export interface PricingOptions {
  /** kasa payı: 0,07 → olasılıklar toplamı %107 */
  margin: number;
  maxOdds: number;
  /** bu olasılığın üstündeki seçenekler kapatılır */
  maxProb: number;
  maxGoalsPerHalf: number;
  /** belirsizlik ortalaması için nokta sayısı (4'ün katı) */
  draws: number;
}

export const DEFAULT_PRICING: PricingOptions = { margin: 0.07, maxOdds: 50, maxProb: 0.95, maxGoalsPerHalf: 40, draws: 2000 };

export interface SelectionDef {
  code: string;
  label: string;
  rule: BetRule;
  prob: number; // adil olasılık
  odds: number | null; // null = kapalı
  /** Maçta oynayanlardan bu seçeneğe bahis yapabilecekler (kendi lehine kuralı) */
  allowed: string[];
}

export interface MarketDef {
  code: string;
  title: string;
  selections: SelectionDef[];
}

export interface MatchPricing {
  rates: Record<Slot, number>;
  expectedGoals: { A: number; B: number };
  probs: { A: number; D: number; B: number };
  markets: MarketDef[];
}

function poissonPmf(mu: number, N: number): number[] {
  // log uzayında: büyük μ'de alt taşma olmaz
  const out = new Array(N + 1).fill(0);
  if (mu <= 0) {
    out[0] = 1;
    return out;
  }
  let lf = 0; // log(k!)
  const lmu = Math.log(mu);
  for (let k = 0; k <= N; k++) {
    if (k > 0) lf += Math.log(k);
    out[k] = Math.exp(-mu + k * lmu - lf);
  }
  return out;
}

/** Bir yarının (A golü, B golü) olasılık matrisi */
export function halfDistribution(lamA: number, lamB: number, N: number): number[][] {
  const T = HALF_MS / 1000;
  const pa = poissonPmf(lamA * T, N);
  const pb = poissonPmf(lamB * T, N);
  const pA = lamA + lamB > 0 ? lamA / (lamA + lamB) : 0.5;
  const M: number[][] = Array.from({ length: N + 2 }, () => new Array(N + 2).fill(0));
  for (let a = 0; a <= N; a++)
    for (let b = 0; b <= N; b++) {
      const q = pa[a] * pb[b];
      M[a + 1][b] += q * pA;
      M[a][b + 1] += q * (1 - pA);
    }
  return normalize(M);
}

function normalize(M: number[][]): number[][] {
  let s = 0;
  for (const r of M) for (const v of r) s += v;
  return M.map((r) => r.map((v) => v / s));
}

export function convolve(X: number[][], Y: number[][]): number[][] {
  const n = X.length + Y.length - 1;
  const Z: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < X.length; a++)
    for (let b = 0; b < X[a].length; b++) {
      const x = X[a][b];
      if (x < 1e-15) continue;
      for (let c = 0; c < Y.length; c++)
        for (let d = 0; d < Y[c].length; d++) {
          const y = Y[c][d];
          if (y < 1e-15) continue;
          Z[a + c][b + d] += x * y;
        }
    }
  return normalize(Z);
}

/** Güç yöntemiyle marj: Σ p_i^k = 1 + m olacak k bulunur, oran = 1 / p_i^k */
export function applyMargin(probs: number[], margin: number): number[] {
  const target = 1 + margin;
  const f = (k: number) => probs.reduce((s, p) => s + (p > 0 ? Math.pow(p, k) : 0), 0);
  let lo = 0.01, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > target) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return probs.map((p) => (p > 0 ? 1 / Math.pow(p, k) : Infinity));
}

function finalizeOdds(raw: number, prob: number, o: PricingOptions): number | null {
  if (!(prob > 0) || prob > o.maxProb) return null;
  const capped = Math.min(raw, o.maxOdds);
  const rounded = Math.floor(capped * 100 + 1e-9) / 100;
  if (rounded < 1.05) return null;
  return rounded;
}

/** n-yollu (olasılıkları toplamı 1 olan) bir pazar oluşturur */
function market(code: string, title: string, sels: Omit<SelectionDef, 'odds'>[], o: PricingOptions): MarketDef {
  const raw = applyMargin(sels.map((s) => s.prob), o.margin);
  return { code, title, selections: sels.map((s, i) => ({ ...s, odds: finalizeOdds(raw[i], s.prob, o) })) };
}

export interface TeamNames {
  A: string;
  B: string;
}

interface Core {
  full: number[][];
  half: number[][];
  pNone: Record<Slot, number>; // oyuncunun maçta hiç gol atamama olasılığı
  goals: Record<Slot, number[]>; // oyuncunun maçtaki gol sayısı dağılımı
  htft: number[][]; // [ilk yarı sonucu][maç sonucu], sıra: A, D, B
  q: Record<Slot, number>; // ilk golü atma olasılığı
}

/**
 * Bir kadronun sonuç dağılımları. Kapalı form: maç boyunca süre içi goller
 * Poisson(360·λ) ve iki son topun her biri A'ya p olasılıkla gider; bu yüzden
 *   P(maç a:b) = Σ_j C(2,j) p^j (1−p)^(2−j) · Pois(a−j; 360λA) · Pois(b−2+j; 360λB)
 * İlk yarı aynı şekilde tek son topla. (Konvolüsyonla birebir aynı sonuç, ~1000 kat hızlı.)
 */
function core(rates: Record<Slot, number>, N: number): Core {
  const lamA = rates.AF + rates.AK;
  const lamB = rates.BF + rates.BK;
  const T = HALF_MS / 1000;
  const pA = lamA + lamB > 0 ? lamA / (lamA + lamB) : 0.5;
  const half = halfDistribution(lamA, lamB, N);
  const PA = poissonPmf(2 * T * lamA, 2 * N);
  const PB = poissonPmf(2 * T * lamB, 2 * N);
  const w = [(1 - pA) ** 2, 2 * pA * (1 - pA), pA ** 2]; // j = A'nın son top golü sayısı
  const size = 2 * N + 3;
  const full: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let j = 0; j <= 2; j++)
    for (let a = 0; a <= 2 * N; a++)
      for (let b = 0; b <= 2 * N; b++) full[a + j][b + 2 - j] += w[j] * PA[a] * PB[b];
  const sum = lamA + lamB;
  const T2 = 2 * T;
  const pNone = {} as Record<Slot, number>;
  const q = {} as Record<Slot, number>;
  const goals = {} as Record<Slot, number[]>;
  for (const s of SLOTS) {
    q[s] = sum > 0 ? rates[s] / sum : 0.25;
    // süre içi goller Poisson(360·λ), iki son topun her biri ayrıca q olasılıkla
    pNone[s] = Math.exp(-T2 * rates[s]) * (1 - q[s]) ** 2;
    const P = poissonPmf(T2 * rates[s], 2 * N);
    const bin = [(1 - q[s]) ** 2, 2 * q[s] * (1 - q[s]), q[s] ** 2];
    const g = new Array(2 * N + 3).fill(0);
    for (let a = 0; a <= 2 * N; a++) for (let j = 0; j <= 2; j++) g[a + j] += P[a] * bin[j];
    goals[s] = g;
  }
  // İY/MS: iki yarı bağımsız; yarıların gol farkı dağılımından O(N²) ile
  const off = N + 1;
  const diff = new Array(2 * off + 1).fill(0);
  half.forEach((row, a) => row.forEach((v, b) => (diff[a - b + off] += v)));
  const idx = (d: number) => (d > 0 ? 0 : d === 0 ? 1 : 2);
  const htft = [0, 1, 2].map(() => [0, 0, 0]);
  diff.forEach((p1, i) => {
    if (p1 < 1e-15) return;
    const d1 = i - off;
    diff.forEach((p2, j) => {
      if (p2 < 1e-15) return;
      htft[idx(d1)][idx(d1 + j - off)] += p1 * p2;
    });
  });
  return { full: normalize(full), half, pNone, q, goals, htft };
}

/** 4×4 simetrik matrisin simetrik karekökü (Jacobi özdeğer ayrışımı); tek ve tabana bağımsızdır */
function symSqrt(C: number[][]): number[][] {
  const n = C.length;
  const A = C.map((r) => [...r]);
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const d = A.map((r, i) => Math.sqrt(Math.max(0, r[i])));
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => V[i].reduce((s, v, k) => s + v * d[k] * V[j][k], 0)));
}

/**
 * Belirsizliği temsil eden gol hızı örnekleri: η = ortalama + S·z (S simetrik karekök).
 * Nokta kümesi z, −z, Πz, −Πz şeklinde (Π: takımların yer değiştirmesi) kurulur. Bu,
 * geçerli bir örneklemdir ve iki takım modelde birebir simetrikse oranları da tam eşit çıkar.
 */
function predictiveDraws(p: ModelParams, l: Lineup, count: number): Record<Slot, number>[] | null {
  const pred = slotPredictive(p, l);
  if (!pred) return null;
  const S = symSqrt(pred.cov);
  const rng = mulberry32(90210);
  const out: Record<Slot, number>[] = [];
  const toRates = (z: number[]) => {
    const eta = pred.mean.map((m, i) => m + S[i].reduce((s, v, j) => s + v * z[j], 0));
    return { AF: Math.exp(eta[0]), AK: Math.exp(eta[1]), BF: Math.exp(eta[2]), BK: Math.exp(eta[3]) };
  };
  for (let k = 0; k < Math.ceil(count / 4); k++) {
    const z = [normal(rng), normal(rng), normal(rng), normal(rng)];
    const pz = [z[2], z[3], z[0], z[1]];
    for (const v of [z, z.map((x) => -x), pz, pz.map((x) => -x)]) out.push(toRates(v));
  }
  return out;
}

function overProb(dist: number[], line: number): number {
  let p = 0;
  dist.forEach((q, t) => t > line && (p += q ?? 0));
  return p;
}

/** Üst olasılığı %50'ye en yakın x,5 çizgisi */
function mainLine(dist: number[]): number {
  let best = 0.5;
  for (let L = 0.5; L < dist.length; L += 1) if (Math.abs(overProb(dist, L) - 0.5) < Math.abs(overProb(dist, best) - 0.5)) best = L;
  return best;
}

export function priceMatch(
  params: ModelParams,
  lineup: Lineup,
  playerName: (id: string) => string,
  opts: Partial<PricingOptions> = {},
): MatchPricing {
  const o = { ...DEFAULT_PRICING, ...opts };
  const rates = slotRates(params, lineup);
  // Belirsizlik örnekleri varsa sonuç dağılımları onların ortalamasıdır (posterior predictive)
  let draws = predictiveDraws(params, lineup, o.draws) ?? [rates];
  const T = HALF_MS / 1000;
  const mus = draws.map((r) => Math.max(r.AF + r.AK, r.BF + r.BK) * T).sort((a, b) => a - b);
  const maxMu = mus[Math.floor(mus.length * 0.999)] ?? mus[mus.length - 1];
  const N = Math.min(o.maxGoalsPerHalf, Math.ceil(maxMu + 6 * Math.sqrt(maxMu) + 6));
  // aşırı uç örnekler (kesme sınırının dışına taşan) ortalamayı bozmasın
  draws = draws.filter((r) => Math.max(r.AF + r.AK, r.BF + r.BK) * T * 2 < 2 * N - 6 * Math.sqrt(2 * N));
  // örnekler tek tek işlenip ortalamaya eklenir (bellek sabit kalır)
  let full: number[][] = [], half: number[][] = [];
  const pNone = { AF: 0, AK: 0, BF: 0, BK: 0 } as Record<Slot, number>;
  const qFirst = { AF: 0, AK: 0, BF: 0, BK: 0 } as Record<Slot, number>;
  const pGoals = { AF: [], AK: [], BF: [], BK: [] } as Record<Slot, number[]>;
  const htft = [0, 1, 2].map(() => [0, 0, 0]);
  if (!draws.length) draws = [rates];
  const k = 1 / draws.length;
  draws.forEach((r, i) => {
    const c = core(r, N);
    if (i === 0) {
      full = c.full.map((row) => row.map(() => 0));
      half = c.half.map((row) => row.map(() => 0));
    }
    c.full.forEach((row, a) => row.forEach((v, b) => (full[a][b] += v * k)));
    c.half.forEach((row, a) => row.forEach((v, b) => (half[a][b] += v * k)));
    for (const s of SLOTS) {
      pNone[s] += c.pNone[s] * k;
      qFirst[s] += c.q[s] * k;
      c.goals[s].forEach((v, g) => (pGoals[s][g] = (pGoals[s][g] ?? 0) + v * k));
    }
    c.htft.forEach((row, i) => row.forEach((v, j) => (htft[i][j] += v * k)));
  });

  let pA = 0, pD = 0, pB = 0, eA = 0, eB = 0, pBtts = 0;
  const totalDist: number[] = [];
  full.forEach((row, a) =>
    row.forEach((q, b) => {
      if (a > b) pA += q;
      else if (a < b) pB += q;
      else pD += q;
      eA += a * q;
      eB += b * q;
      if (a > 0 && b > 0) pBtts += q;
      totalDist[a + b] = (totalDist[a + b] ?? 0) + q;
    }),
  );
  let hA = 0, hD = 0, hB = 0;
  const halfTotal: number[] = [];
  half.forEach((row, a) =>
    row.forEach((q, b) => {
      if (a > b) hA += q;
      else if (a < b) hB += q;
      else hD += q;
      halfTotal[a + b] = (halfTotal[a + b] ?? 0) + q;
    }),
  );

  const teamA = [lineup.AF, lineup.AK];
  const teamB = [lineup.BF, lineup.BK];
  const teamOf = (t: Team) => (t === 'A' ? teamA : teamB);

  const markets: MarketDef[] = [];
  markets.push(
    market('ms', 'Maç Sonucu', [
      { code: '1', label: 'Mavi', rule: { k: 'ms', o: 'A' }, prob: pA, allowed: teamA },
      { code: 'X', label: 'Beraberlik', rule: { k: 'ms', o: 'D' }, prob: pD, allowed: [] },
      { code: '2', label: 'Kırmızı', rule: { k: 'ms', o: 'B' }, prob: pB, allowed: teamB },
    ], o),
  );
  // Çifte şans: üç seçenek birbirini dışlamaz; her biri kendi 2-yollu pazarı gibi fiyatlanır
  const dc = (code: string, label: string, os: ['A' | 'D' | 'B', 'A' | 'D' | 'B'], p: number, allowed: string[]): SelectionDef => {
    const [raw] = applyMargin([p, 1 - p], o.margin);
    return { code, label, rule: { k: 'dc', o: os }, prob: p, odds: finalizeOdds(raw, p, o), allowed };
  };
  markets.push({
    code: 'dc',
    title: 'Çifte Şans',
    selections: [
      dc('1X', 'Mavi veya Beraberlik', ['A', 'D'], pA + pD, teamA),
      dc('12', 'Mavi veya Kırmızı', ['A', 'B'], pA + pB, []),
      dc('X2', 'Beraberlik veya Kırmızı', ['D', 'B'], pD + pB, teamB),
    ],
  });
  markets.push(
    market('ht', 'İlk Yarı Sonucu', [
      { code: '1', label: 'Mavi', rule: { k: 'ht', o: 'A' }, prob: hA, allowed: teamA },
      { code: 'X', label: 'Beraberlik', rule: { k: 'ht', o: 'D' }, prob: hD, allowed: [] },
      { code: '2', label: 'Kırmızı', rule: { k: 'ht', o: 'B' }, prob: hB, allowed: teamB },
    ], o),
  );
  // İkinci yarı: yarılar aynı dağılımda ve bağımsız olduğundan olasılıklar ilk yarıyla aynıdır
  markets.push(
    market('h2', 'İkinci Yarı Sonucu', [
      { code: '1', label: 'Mavi', rule: { k: 'h2', o: 'A' }, prob: hA, allowed: teamA },
      { code: 'X', label: 'Beraberlik', rule: { k: 'h2', o: 'D' }, prob: hD, allowed: [] },
      { code: '2', label: 'Kırmızı', rule: { k: 'h2', o: 'B' }, prob: hB, allowed: teamB },
    ], o),
  );
  const OUT = ['A', 'D', 'B'] as const;
  const short = { A: '1', D: 'X', B: '2' } as const;
  const long = { A: 'Mavi', D: 'Ber.', B: 'Kırmızı' } as const;
  const htftSels: Omit<SelectionDef, 'odds'>[] = [];
  OUT.forEach((h, i) =>
    OUT.forEach((f, j) =>
      htftSels.push({
        code: `${short[h]}/${short[f]}`,
        label: `${long[h]} / ${long[f]}`,
        rule: { k: 'htft', ht: h, ft: f },
        prob: htft[i][j],
        // oynayan sadece takımının hem ilk yarıyı hem maçı aldığı seçeneğe oynayabilir
        allowed: h === f && h !== 'D' ? teamOf(h) : [],
      }),
    ),
  );
  markets.push(market('htft', 'İlk Yarı / Maç Sonucu', htftSels, o));

  // Alt/Üst: üst olasılığı %50'ye en yakın çizgi + bir alt + bir üst çizgi
  const pOver = (line: number) => overProb(totalDist, line);
  const main = mainLine(totalDist);
  for (const L of [main - 1, main, main + 1]) {
    if (L < 0.5) continue;
    const p = pOver(L);
    const lbl = L.toFixed(1).replace('.', ',');
    markets.push(
      market(`ou_${L}`, `Toplam Gol ${lbl} Alt/Üst`, [
        { code: 'U', label: `${lbl} Alt`, rule: { k: 'ou', line: L, side: 'under' }, prob: 1 - p, allowed: [] },
        { code: 'O', label: `${lbl} Üst`, rule: { k: 'ou', line: L, side: 'over' }, prob: p, allowed: [] },
      ], o),
    );
  }

  // İlk yarı alt/üst
  const htMain = mainLine(halfTotal);
  for (const L of [htMain - 1, htMain, htMain + 1]) {
    if (L < 0.5) continue;
    const p = overProb(halfTotal, L);
    const lbl = L.toFixed(1).replace('.', ',');
    markets.push(
      market(`htou_${L}`, `İlk Yarı ${lbl} Alt/Üst`, [
        { code: 'U', label: `İY ${lbl} Alt`, rule: { k: 'htou', line: L, side: 'under' }, prob: 1 - p, allowed: [] },
        { code: 'O', label: `İY ${lbl} Üst`, rule: { k: 'htou', line: L, side: 'over' }, prob: p, allowed: [] },
      ], o),
    );
  }

  markets.push(
    market('btts', 'Karşılıklı Gol', [
      { code: 'Y', label: 'Var', rule: { k: 'btts', yes: true }, prob: pBtts, allowed: [] },
      { code: 'N', label: 'Yok', rule: { k: 'btts', yes: false }, prob: 1 - pBtts, allowed: [] },
    ], o),
  );

  // Oyuncu bazlı pazarlar
  const fg: Omit<SelectionDef, 'odds'>[] = [];
  for (const s of SLOTS) {
    const pid = lineup[s];
    const team = s[0] as Team;
    const name = playerName(pid);
    const roleTxt = s[1] === 'F' ? 'forvet' : 'kaleci';
    markets.push(
      market(`pg_${pid}`, `${name} (${roleTxt}) Gol Atar`, [
        { code: 'Y', label: 'Evet', rule: { k: 'pg', player: pid, yes: true }, prob: 1 - pNone[s], allowed: teamOf(team) },
        { code: 'N', label: 'Hayır', rule: { k: 'pg', player: pid, yes: false }, prob: pNone[s], allowed: [] },
      ], o),
    );
    const gl = mainLine(pGoals[s]);
    const glTxt = gl.toFixed(1).replace('.', ',');
    const po = overProb(pGoals[s], gl);
    markets.push(
      market(`pgl_${pid}`, `${name} Gol Sayısı ${glTxt} Alt/Üst`, [
        { code: 'U', label: `${glTxt} Alt`, rule: { k: 'pgl', player: pid, line: gl, side: 'under' }, prob: 1 - po, allowed: [] },
        { code: 'O', label: `${glTxt} Üst`, rule: { k: 'pgl', player: pid, line: gl, side: 'over' }, prob: po, allowed: teamOf(team) },
      ], o),
    );
    fg.push({ code: pid, label: name, rule: { k: 'fg', player: pid }, prob: qFirst[s], allowed: teamOf(team) });
  }
  markets.push(market('fg', 'İlk Golü Atan', fg, o));

  return { rates, expectedGoals: { A: eA, B: eB }, probs: { A: pA, D: pD, B: pB }, markets };
}
