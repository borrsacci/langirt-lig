// İstatistiksel güç modeli
// =========================
// Langırtta goller birbirinden bağımsız ve rastgele aralıklarla gelir; bu tip
// olaylar için standart araç Poisson sürecidir (futbol bahis modellerinin
// temeli olan Dixon-Coles / Maher modelleri de böyledir). Buradaki model, 2'ye 2
// langırta göre genişletildi:
//
//   X takımının forvetinin gol hızı (gol/sn):
//     log λ = μ_F + (Q_X − Q_Y) + hücumF(forvet_X) − savunmaK(kaleci_Y) − savunmaF(forvet_Y)
//   X takımının kalecisinin gol hızı:
//     log λ = μ_K + (Q_X − Q_Y) + hücumK(kaleci_X) − savunmaK(kaleci_Y) − savunmaF(forvet_Y)
//   Q_X = genel(forvet_X) + genel(kaleci_X) + uyum(ikili_X)
//
// - "genel" oyuncunun mevkiden bağımsız gücü; az veride bile tüm mevkilere bilgi taşır.
// - hücumF / hücumK / savunmaF / savunmaK mevkiye özel güçler: kim hangi mevkide iyi.
// - "uyum" belirli bir ikilinin birlikte oynayınca ortaya çıkan ekstra gücü.
// - Süre bittikten sonraki "son top" golleri, 4 gol hızının yarışı olarak
//   (λ_atan / Σλ) modele dahil edilir.
// - Eski maçların ağırlığı yarı-ömür ile azalır (form etkisi).
// - Tüm parametreler 0'a doğru çekilir (Bayesçi ridge önseli): az maçta oranlar
//   dengeli kalır, veri biriktikçe gerçek farklar ortaya çıkar. Aşırı uyum olmaz.
// Uyum, cezalı en çok olabilirlik ile Newton yöntemiyle (konkav problem → tek tepe) yapılır.

import { segmentsOf } from './game.ts';
import { type Lineup, type MatchCore, type MatchEvent, type Slot, pairKey } from './types.ts';

export interface PlayerParams {
  g: number;
  aF: number;
  aK: number;
  dF: number;
  dK: number;
}

export interface ModelParams {
  muF: number;
  muK: number;
  players: Record<string, PlayerParams>;
  pairs: Record<string, number>;
  /** modele giren (ağırlıklı) maç sayısı */
  nMatches: number;
  effMatches: number;
  /** parametre belirsizliği (Laplace yaklaşımı): oran hesabında kullanılır */
  posterior?: Posterior;
}

export interface Posterior {
  n: number;
  /** −Hessian'ın Cholesky çarpanı (H = L·Lᵀ, kovaryans = H⁻¹) */
  L: Float64Array;
  theta: Float64Array;
  players: Map<string, number>;
  pairs: Map<string, number>;
}

export interface FitOptions {
  /** maç ağırlığının yarıya düştüğü gün sayısı */
  halfLifeDays: number;
  sigmaG: number;
  sigmaRole: number;
  sigmaPair: number;
  sigmaMu: number;
  muF0: number;
  muK0: number;
  /** verisi olmasa da modele (önselden belirsizlikle) dahil edilecek oyuncu ve ikililer */
  include?: { players?: string[]; pairs?: [string, string][] };
  /** belirsizlik (posterior) hesaplansın mı */
  posterior: boolean;
  now?: number;
}

// Önsel ortalamalar: forvet yarı başına ~2,25 gol, kaleci ~0,45 gol (180 sn).
export const DEFAULT_FIT: FitOptions = {
  halfLifeDays: 120,
  sigmaG: 0.22,
  sigmaRole: 0.18,
  sigmaPair: 0.12,
  sigmaMu: 0.5,
  muF0: Math.log(2.25 / 180),
  muK0: Math.log(0.45 / 180),
  posterior: false,
};

export interface MatchRecord {
  match: MatchCore;
  events: MatchEvent[];
}

export function emptyParams(o: FitOptions = DEFAULT_FIT): ModelParams {
  return { muF: o.muF0, muK: o.muK0, players: {}, pairs: {}, nMatches: 0, effMatches: 0 };
}

type Feat = [number, number][]; // [parametre indeksi, katsayı]

class Index {
  players = new Map<string, number>();
  pairs = new Map<string, number>();
  size = 2;
  player(id: string): number {
    let i = this.players.get(id);
    if (i === undefined) {
      i = this.size;
      this.players.set(id, i);
      this.size += 5;
    }
    return i;
  }
  pair(p: string, q: string): number {
    const k = pairKey(p, q);
    let i = this.pairs.get(k);
    if (i === undefined) {
      i = this.size;
      this.pairs.set(k, i);
      this.size += 1;
    }
    return i;
  }
}
const G = 0, AF = 1, AK = 2, DF = 3, DK = 4;

function slotFeatures(ix: Index, l: Lineup, slot: Slot): Feat {
  const X = slot[0] === 'A' ? 'A' : 'B';
  const Y = X === 'A' ? 'B' : 'A';
  const xf = l[`${X}F` as Slot], xk = l[`${X}K` as Slot];
  const yf = l[`${Y}F` as Slot], yk = l[`${Y}K` as Slot];
  const f: Feat = [];
  f.push([slot[1] === 'F' ? 0 : 1, 1]);
  f.push([ix.player(xf) + G, 1], [ix.player(xk) + G, 1], [ix.pair(xf, xk), 1]);
  f.push([ix.player(yf) + G, -1], [ix.player(yk) + G, -1], [ix.pair(yf, yk), -1]);
  if (slot[1] === 'F') f.push([ix.player(xf) + AF, 1]);
  else f.push([ix.player(xk) + AK, 1]);
  f.push([ix.player(yk) + DK, -1], [ix.player(yf) + DF, -1]);
  return f;
}

function dot(f: Feat, th: Float64Array): number {
  let s = 0;
  for (const [i, c] of f) s += c * th[i];
  return Math.max(-25, Math.min(5, s));
}

interface Obs {
  wt: number; // Σ ağırlık × süre (sn)
  wn: number; // Σ ağırlık × gol
  feat: Feat;
}
interface RaceObs {
  w: number;
  feats: Feat[];
  scorer: number;
}

const ORDER: Slot[] = ['AF', 'AK', 'BF', 'BK'];
const lineupKey = (l: Lineup) => `${l.AF},${l.AK},${l.BF},${l.BK}`;

export function fitModel(records: MatchRecord[], opts: Partial<FitOptions> = {}): ModelParams {
  const o = { ...DEFAULT_FIT, ...opts };
  const now = o.now ?? Date.now();
  const ix = new Index();
  // Aynı kadro + slot gözlemleri yeterli istatistiklerde birleştirilir: hız, maç
  // sayısından değil farklı kadro sayısından etkilenir (binlerce maçta da hızlı).
  const obsMap = new Map<string, Obs>();
  const raceMap = new Map<string, RaceObs>();
  let eff = 0;
  for (const r of records) {
    const ageDays = Math.max(0, (now - Date.parse(r.match.created_at)) / 86_400_000);
    const w = Math.pow(0.5, ageDays / o.halfLifeDays);
    eff += w;
    const { segments, races: rg } = segmentsOf(r.match, r.events);
    for (const s of segments) {
      const lk = lineupKey(s.lineup);
      ORDER.forEach((sl) => {
        const k = `${lk}:${sl}`;
        let ob = obsMap.get(k);
        if (!ob) obsMap.set(k, (ob = { wt: 0, wn: 0, feat: slotFeatures(ix, s.lineup, sl) }));
        ob.wt += (w * s.ms) / 1000;
        ob.wn += w * s.goals[sl];
      });
    }
    for (const g of rg) {
      const k = `${lineupKey(g.lineup)}:${g.scorer}`;
      let rc = raceMap.get(k);
      if (!rc) raceMap.set(k, (rc = { w: 0, feats: ORDER.map((sl) => slotFeatures(ix, g.lineup, sl)), scorer: ORDER.indexOf(g.scorer) }));
      rc.w += w;
    }
  }
  for (const id of o.include?.players ?? []) ix.player(id);
  for (const [a, b] of o.include?.pairs ?? []) ix.pair(a, b);
  const obs = [...obsMap.values()];
  const races = [...raceMap.values()];

  const n = ix.size;
  const mean = new Float64Array(n);
  const prec = new Float64Array(n);
  mean[0] = o.muF0; mean[1] = o.muK0;
  prec[0] = prec[1] = 1 / (o.sigmaMu * o.sigmaMu);
  for (const base of ix.players.values()) {
    prec[base + G] = 1 / (o.sigmaG * o.sigmaG);
    for (const k of [AF, AK, DF, DK]) prec[base + k] = 1 / (o.sigmaRole * o.sigmaRole);
  }
  for (const i of ix.pairs.values()) prec[i] = 1 / (o.sigmaPair * o.sigmaPair);

  const th = Float64Array.from(mean);

  const objective = (t: Float64Array): number => {
    let ll = 0;
    for (const ob of obs) {
      const eta = dot(ob.feat, t);
      ll += ob.wn * eta - ob.wt * Math.exp(eta);
    }
    for (const rc of races) {
      const etas = rc.feats.map((f) => dot(f, t));
      const m = Math.max(...etas);
      const lse = m + Math.log(etas.reduce((s, e) => s + Math.exp(e - m), 0));
      ll += rc.w * (etas[rc.scorer] - lse);
    }
    for (let i = 0; i < n; i++) ll -= 0.5 * prec[i] * (t[i] - mean[i]) ** 2;
    return ll;
  };

  const gradHess = (th: Float64Array) => {
    const grad = new Float64Array(n);
    const H = new Float64Array(n * n); // −Hessian (pozitif tanımlı)
    const addOuter = (f: Feat, c: number) => {
      for (const [i, a] of f) for (const [j, b] of f) H[i * n + j] += c * a * b;
    };
    for (const ob of obs) {
      const lam = Math.exp(dot(ob.feat, th));
      const r = ob.wn - ob.wt * lam;
      for (const [i, c] of ob.feat) grad[i] += r * c;
      addOuter(ob.feat, ob.wt * lam);
    }
    for (const rc of races) {
      const etas = rc.feats.map((f) => dot(f, th));
      const m = Math.max(...etas);
      const ex = etas.map((e) => Math.exp(e - m));
      const z = ex.reduce((s, e) => s + e, 0);
      const p = ex.map((e) => e / z);
      // ortalama özellik vektörü
      const xbar = new Map<number, number>();
      for (let j = 0; j < 4; j++) for (const [i, c] of rc.feats[j]) xbar.set(i, (xbar.get(i) ?? 0) + p[j] * c);
      for (const [i, c] of rc.feats[rc.scorer]) grad[i] += rc.w * c;
      for (const [i, c] of xbar) grad[i] -= rc.w * c;
      for (let j = 0; j < 4; j++) addOuter(rc.feats[j], rc.w * p[j]);
      const xb: Feat = [...xbar.entries()];
      addOuter(xb, -rc.w);
    }
    for (let i = 0; i < n; i++) {
      grad[i] -= prec[i] * (th[i] - mean[i]);
      H[i * n + i] += prec[i];
    }
    return { grad, H };
  };

  let fCur = objective(th);
  for (let iter = 0; iter < 60; iter++) {
    const { grad, H } = gradHess(th);
    const step = choleskySolve(H, grad, n);
    if (!step) break;
    let alpha = 1;
    let accepted = false;
    for (let ls = 0; ls < 30; ls++) {
      const cand = new Float64Array(n);
      for (let i = 0; i < n; i++) cand[i] = th[i] + alpha * step[i];
      const fc = objective(cand);
      if (fc >= fCur - 1e-9 * Math.abs(fCur)) {
        th.set(cand);
        fCur = fc;
        accepted = true;
        break;
      }
      alpha /= 2;
    }
    if (!accepted) break;
    // yakınsama: Newton adımı ihmal edilebilir boyutta
    let maxStep = 0;
    for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(alpha * step[i]));
    if (maxStep < 1e-7) break;
  }

  const toParams = (t: Float64Array): ModelParams => {
    const players: Record<string, PlayerParams> = {};
    for (const [id, b] of ix.players) players[id] = { g: t[b + G], aF: t[b + AF], aK: t[b + AK], dF: t[b + DF], dK: t[b + DK] };
    const pairs: Record<string, number> = {};
    for (const [k, i] of ix.pairs) pairs[k] = t[i];
    return { muF: t[0], muK: t[1], players, pairs, nMatches: records.length, effMatches: eff };
  };
  const result = toParams(th);

  // Belirsizlik: Laplace yaklaşımı θ ~ N(θ̂, H⁻¹). Oran hesabı bunu kullanır; böylece
  // az maç oynamış oyuncuların gücü "kesin" sanılmaz, model aşırı emin olmaz.
  if (o.posterior) {
    const { H } = gradHess(th);
    const L = cholesky(H, n);
    if (L) result.posterior = { n, L, theta: Float64Array.from(th), players: ix.players, pairs: ix.pairs };
  }
  return result;
}

function cholesky(A: Float64Array, n: number): Float64Array | null {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (s <= 1e-14) return null;
        L[i * n + i] = Math.sqrt(s);
      } else L[i * n + j] = s / L[j * n + j];
    }
  }
  return L;
}

function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = cholesky(A, n);
  if (!L) return null;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

const ZERO: PlayerParams = { g: 0, aF: 0, aK: 0, dF: 0, dK: 0 };

export function playerParams(p: ModelParams, id: string): PlayerParams {
  return p.players[id] ?? ZERO;
}

/** Bir kadro için 4 slotun gol hızları (gol/sn) */
export function slotRates(p: ModelParams, l: Lineup): Record<Slot, number> {
  const P = (id: string) => playerParams(p, id);
  const pair = (a: string, b: string) => p.pairs[pairKey(a, b)] ?? 0;
  const QA = P(l.AF).g + P(l.AK).g + pair(l.AF, l.AK);
  const QB = P(l.BF).g + P(l.BK).g + pair(l.BF, l.BK);
  const defA = P(l.AK).dK + P(l.AF).dF;
  const defB = P(l.BK).dK + P(l.BF).dF;
  return {
    AF: Math.exp(p.muF + QA - QB + P(l.AF).aF - defB),
    AK: Math.exp(p.muK + QA - QB + P(l.AK).aK - defB),
    BF: Math.exp(p.muF + QB - QA + P(l.BF).aF - defA),
    BK: Math.exp(p.muK + QB - QA + P(l.BK).aK - defA),
  };
}

/**
 * Ekranda gösterilecek mevki güçleri: ortalama bir takım arkadaşı ve ortalama
 * rakiplerle, 3 dakikalık bir yarıda beklenen gol farkına katkı.
 * (+0,5 = takımına yarı başına yarım gol avantaj kazandırıyor demek)
 */
export function roleImpact(p: ModelParams, id: string): { F: number; K: number } {
  const pp = playerParams(p, id);
  const T = 180;
  const baseF = Math.exp(p.muF) * T, baseK = Math.exp(p.muK) * T;
  const base = baseF + baseK;
  // forvetken: takım hücumu ve savunması
  const forF = baseF * Math.exp(pp.g + pp.aF) + baseK * Math.exp(pp.g) - (base * Math.exp(-pp.g - pp.dF));
  const forK = baseF * Math.exp(pp.g) + baseK * Math.exp(pp.g + pp.aK) - (base * Math.exp(-pp.g - pp.dK));
  // ortalama oyuncuya göre fark (ortalama oyuncuda ikisi de 0)
  return { F: forF, K: forK };
}

/** Bir kadro için oran hesabında kullanılacak modeli kurar (belirsizlik örnekleriyle) */
export function fitForLineup(records: MatchRecord[], l: Lineup, opts: Partial<FitOptions> = {}): ModelParams {
  return fitModel(records, {
    posterior: true,
    include: { players: [l.AF, l.AK, l.BF, l.BK], pairs: [[l.AF, l.AK], [l.BF, l.BK]] },
    ...opts,
  });
}

/**
 * Bir kadronun 4 slotunun log gol hızlarının (η) ortalaması ve kovaryansı:
 * η = X·θ olduğundan Cov(η) = X·H⁻¹·Xᵀ. Modelde olmayan parametreler 0 kabul edilir.
 */
export function slotPredictive(p: ModelParams, l: Lineup): { mean: number[]; cov: number[][] } | null {
  const post = p.posterior;
  if (!post) return null;
  const { n, L } = post;
  const ix = {
    player: (id: string) => post.players.get(id),
    pair: (a: string, b: string) => post.pairs.get(pairKey(a, b)),
  };
  const feats = ORDER.map((sl) => {
    const X = sl[0], Y = X === 'A' ? 'B' : 'A';
    const xf = l[`${X}F` as Slot], xk = l[`${X}K` as Slot], yf = l[`${Y}F` as Slot], yk = l[`${Y}K` as Slot];
    const f: Feat = [[sl[1] === 'F' ? 0 : 1, 1]];
    const add = (i: number | undefined, off: number, c: number) => i !== undefined && f.push([i + off, c]);
    add(ix.player(xf), G, 1); add(ix.player(xk), G, 1); add(ix.pair(xf, xk), 0, 1);
    add(ix.player(yf), G, -1); add(ix.player(yk), G, -1); add(ix.pair(yf, yk), 0, -1);
    if (sl[1] === 'F') add(ix.player(xf), AF, 1);
    else add(ix.player(xk), AK, 1);
    add(ix.player(yk), DK, -1); add(ix.player(yf), DF, -1);
    return f;
  });
  const r = slotRates(p, l);
  const mean = ORDER.map((sl) => Math.log(r[sl]));
  // y_s = L⁻¹ x_s  →  Cov_st = y_s · y_t
  const ys = feats.map((f) => {
    const x = new Float64Array(n);
    for (const [i, c] of f) x[i] += c;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = x[i];
      for (let k = 0; k < i; k++) v -= L[i * n + k] * y[k];
      y[i] = v / L[i * n + i];
    }
    return y;
  });
  const cov = ys.map((a) => ys.map((b) => a.reduce((s, v, i) => s + v * b[i], 0)));
  return { mean, cov };
}
