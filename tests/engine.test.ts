import { describe, expect, it } from 'vitest';
import { drawTeams } from '../supabase/functions/_shared/draw.ts';
import { deriveFacts, roleTimes, segmentsOf } from '../supabase/functions/_shared/game.ts';
import { emptyParams, fitForLineup, fitModel, type ModelParams } from '../supabase/functions/_shared/model.ts';
import { applyMargin, priceMatch } from '../supabase/functions/_shared/pricing.ts';
import { settleRule } from '../supabase/functions/_shared/settle.ts';
import { HALF_MS, type Lineup, pairKey } from '../supabase/functions/_shared/types.ts';
import { mulberry32, simulateMatch } from './sim.ts';

const names = (id: string) => id;

function truthParams(): ModelParams {
  const p = emptyParams();
  p.players = {
    ace: { g: 0.25, aF: 0.35, aK: -0.1, dF: 0.05, dK: 0.0 }, // çok iyi forvet
    wall: { g: 0.15, aF: -0.1, aK: 0.1, dF: 0.0, dK: 0.4 }, // çok iyi kaleci
    mid1: { g: 0, aF: 0, aK: 0, dF: 0, dK: 0 },
    mid2: { g: 0.05, aF: 0, aK: 0, dF: 0, dK: 0 },
    mid3: { g: -0.05, aF: 0.05, aK: 0, dF: 0, dK: -0.05 },
    mid4: { g: 0, aF: -0.05, aK: 0.05, dF: 0, dK: 0.05 },
    weak: { g: -0.3, aF: -0.2, aK: 0, dF: 0, dK: -0.2 },
    rook: { g: -0.15, aF: 0, aK: 0, dF: -0.1, dK: -0.1 },
  };
  p.pairs = { [pairKey('mid1', 'mid2')]: 0.2 };
  return p;
}

describe('fiyatlama analitik dağılımı gerçek oyunla birebir uyuşur', () => {
  it('simülasyon frekansları ≈ model olasılıkları', () => {
    const truth = truthParams();
    const lineup: Lineup = { AF: 'ace', AK: 'mid1', BF: 'mid2', BK: 'wall' };
    const pr = priceMatch(truth, lineup, names);
    const rng = mulberry32(42);
    const N = 30000;
    let a = 0, d = 0, b = 0, ha = 0, hd = 0, btts = 0, aceScores = 0, aceFirst = 0, over: Record<string, number> = {};
    const ouMarkets = pr.markets.filter((m) => m.code.startsWith('ou_') || m.code.startsWith('pgl_'));
    for (let i = 0; i < N; i++) {
      const { events } = simulateMatch(truth, lineup, rng);
      const f = deriveFacts(events);
      if (f.goalsA > f.goalsB) a++; else if (f.goalsA < f.goalsB) b++; else d++;
      if (f.htA > f.htB) ha++; else if (f.htA === f.htB) hd++;
      if (f.goalsA > 0 && f.goalsB > 0) btts++;
      if ((f.playerGoals['ace'] ?? 0) > 0) aceScores++;
      if (f.firstScorer === 'ace') aceFirst++;
      for (const m of ouMarkets) {
        const sel = m.selections.find((s) => s.code === 'O')!;
        if (settleRule(sel.rule, f) === 'won') over[m.code] = (over[m.code] ?? 0) + 1;
      }
    }
    const tol = 0.012;
    expect(Math.abs(a / N - pr.probs.A)).toBeLessThan(tol);
    expect(Math.abs(d / N - pr.probs.D)).toBeLessThan(tol);
    expect(Math.abs(b / N - pr.probs.B)).toBeLessThan(tol);
    const ht = pr.markets.find((m) => m.code === 'ht')!;
    expect(Math.abs(ha / N - ht.selections[0].prob)).toBeLessThan(tol);
    expect(Math.abs(hd / N - ht.selections[1].prob)).toBeLessThan(tol);
    const bt = pr.markets.find((m) => m.code === 'btts')!;
    expect(Math.abs(btts / N - bt.selections[0].prob)).toBeLessThan(tol);
    const pg = pr.markets.find((m) => m.code === 'pg_ace')!;
    expect(Math.abs(aceScores / N - pg.selections[0].prob)).toBeLessThan(tol);
    const fg = pr.markets.find((m) => m.code === 'fg')!;
    expect(Math.abs(aceFirst / N - fg.selections.find((s) => s.code === 'ace')!.prob)).toBeLessThan(tol);
    for (const m of ouMarkets) {
      const sel = m.selections.find((s) => s.code === 'O')!;
      expect(Math.abs((over[m.code] ?? 0) / N - sel.prob)).toBeLessThan(tol);
    }
    // iyi forvet + iyi kaleci karşı karşıya; ikisi de favori sayılmamalı ama dengesiz de değil
    expect(pr.probs.A + pr.probs.D + pr.probs.B).toBeCloseTo(1, 9);
  });
});

describe('kasa payı', () => {
  it('hiçbir oran adil oranın üstünde değil, marj hedefte', () => {
    const truth = truthParams();
    for (const lineup of [
      { AF: 'ace', AK: 'wall', BF: 'weak', BK: 'rook' },
      { AF: 'mid1', AK: 'mid2', BF: 'mid3', BK: 'mid4' },
      { AF: 'weak', AK: 'rook', BF: 'ace', BK: 'wall' },
    ] as Lineup[]) {
      const pr = priceMatch(truth, lineup, names);
      for (const m of pr.markets) {
        for (const s of m.selections) {
          if (s.odds === null) continue;
          expect(s.odds).toBeGreaterThanOrEqual(1.05);
          expect(s.odds).toBeLessThanOrEqual(50);
          expect(s.odds * s.prob).toBeLessThan(1); // beklenen değer daima < 1
          expect(Math.abs(s.odds * 100 - Math.round(s.odds * 100))).toBeLessThan(1e-6); // 2 hane
        }
        if (m.code !== 'dc' && m.selections.every((s) => s.odds !== null && s.odds < 50)) {
          const book = m.selections.reduce((t, s) => t + 1 / s.odds!, 0);
          expect(book).toBeGreaterThan(1.069);
          expect(book).toBeLessThan(1.1);
        }
      }
    }
  });
  it('power yöntemi favoriye az, sürprize çok marj yükler', () => {
    const [fav, dog] = applyMargin([0.8, 0.2], 0.07);
    expect(1 / fav - 0.8).toBeLessThan(1 / dog - 0.2);
  });
  it('kaçınılmaz sonuçlar bahse kapalı', () => {
    const p = emptyParams();
    p.players = { s1: { g: 1.2, aF: 0.5, aK: 0, dF: 0, dK: 0.5 }, s2: { g: 1.2, aF: 0, aK: 0, dF: 0, dK: 0.5 } };
    const pr = priceMatch(p, { AF: 's1', AK: 's2', BF: 'x', BK: 'y' }, names);
    const ms = pr.markets.find((m) => m.code === 'ms')!;
    expect(ms.selections[0].prob).toBeGreaterThan(0.95);
    expect(ms.selections[0].odds).toBeNull();
  });
});

describe('model', () => {
  it('veri yokken iki takım eşit', () => {
    const pr = priceMatch(fitModel([]), { AF: 'a', AK: 'b', BF: 'c', BK: 'd' }, names);
    expect(pr.probs.A).toBeCloseTo(pr.probs.B, 10);
    const ms = pr.markets[0].selections;
    expect(ms[0].odds).toBe(ms[2].odds);
  });

  it('gerçek güçleri veriden geri bulur (mevki bazlı ve ikili uyum)', () => {
    const truth = truthParams();
    const ids = Object.keys(truth.players);
    const rng = mulberry32(7);
    const recs = [];
    for (let i = 0; i < 1200; i++) {
      const pool = [...ids].sort(() => rng() - 0.5).slice(0, 4);
      const l = drawTeams(pool, {}, rng);
      recs.push(simulateMatch(truth, l, rng, { swapProb: 0.2 }));
    }
    const fit = fitModel(recs);
    const F = (id: string) => fit.players[id].g + fit.players[id].aF;
    const Kdef = (id: string) => fit.players[id].g + fit.players[id].dK;
    // en iyi forvet "ace", en iyi kaleci "wall", en zayıf "weak"
    expect(ids.every((id) => id === 'ace' || F('ace') > F(id))).toBe(true);
    expect(ids.every((id) => id === 'wall' || Kdef('wall') > Kdef(id))).toBe(true);
    expect(ids.every((id) => id === 'weak' || fit.players['weak'].g < fit.players[id].g)).toBe(true);
    // modelin kazanma olasılıkları gerçeğe yakın
    for (const l of [
      { AF: 'ace', AK: 'wall', BF: 'weak', BK: 'rook' },
      { AF: 'mid1', AK: 'mid2', BF: 'mid3', BK: 'mid4' },
      { AF: 'wall', AK: 'ace', BF: 'mid2', BK: 'mid4' },
    ] as Lineup[]) {
      const t = priceMatch(truth, l, names).probs;
      const e = priceMatch(fit, l, names).probs;
      expect(Math.abs(t.A - e.A)).toBeLessThan(0.07);
    }
    // aynı oyuncu yanlış mevkide daha zayıf görünür
    const pr1 = priceMatch(fit, { AF: 'ace', AK: 'wall', BF: 'mid3', BK: 'mid4' }, names).probs.A;
    const pr2 = priceMatch(fit, { AF: 'wall', AK: 'ace', BF: 'mid3', BK: 'mid4' }, names).probs.A;
    expect(pr1).toBeGreaterThan(pr2);
  });

  it('eski maçların ağırlığı azalır (form)', () => {
    const good = emptyParams();
    good.players = { up: { g: 0.5, aF: 0, aK: 0, dF: 0, dK: 0 } };
    const bad = emptyParams();
    bad.players = { up: { g: -0.5, aF: 0, aK: 0, dF: 0, dK: 0 } };
    const rng = mulberry32(3);
    const now = Date.parse('2026-06-01T00:00:00Z');
    const L: Lineup = { AF: 'up', AK: 'x1', BF: 'x2', BK: 'x3' };
    const old = Array.from({ length: 150 }, () => simulateMatch(bad, L, rng, { createdAt: '2025-06-01T00:00:00Z' }));
    const recent = Array.from({ length: 60 }, () => simulateMatch(good, L, rng, { createdAt: '2026-05-25T00:00:00Z' }));
    const withForm = priceMatch(fitModel([...old, ...recent], { now }), L, names).probs.A;
    const noForm = priceMatch(fitModel([...old, ...recent], { now, halfLifeDays: 1e9 }), L, names).probs.A;
    expect(withForm).toBeGreaterThan(0.5); // son form iyi → favori
    expect(noForm).toBeLessThan(0.5); // form olmasa eski kötü maçlar baskın olurdu
  });

  it('belirsizlik örnekleri: az veride oranlar aşırı emin değil', () => {
    const truth = truthParams();
    const rng = mulberry32(21);
    const L: Lineup = { AF: 'ace', AK: 'wall', BF: 'weak', BK: 'rook' };
    const recs = Array.from({ length: 8 }, () => simulateMatch(truth, L, rng));
    const map = priceMatch(fitModel(recs), L, names);
    const lap = priceMatch(fitModel(recs, { posterior: true, now: 1.8e12 }), L, names);
    expect(lap.probs.A).toBeLessThan(map.probs.A);
    expect(lap.probs.A).toBeGreaterThan(0.5);
    expect(lap.probs.A + lap.probs.D + lap.probs.B).toBeCloseTo(1, 9);
    // aynı veriyle aynı oranlar (tekrarlanabilir)
    const lap2 = priceMatch(fitModel(recs, { posterior: true, now: 1.8e12 }), L, names);
    expect(lap2.markets).toEqual(lap.markets);
    // hiç görülmemiş oyuncular da fiyatlanabilir
    const NL: Lineup = { AF: 'new1', AK: 'new2', BF: 'new3', BK: 'new4' };
    const nw = priceMatch(fitForLineup(recs, NL, { now: 1.8e12 }), NL, names);
    expect(Math.abs(nw.probs.A - nw.probs.B)).toBeLessThan(0.01);
  });

  it('hiç veri yokken eşit takımlar eşit oran alır (örnekleme gürültüsü yok)', () => {
    for (const L of [
      { AF: 'a', AK: 'b', BF: 'c', BK: 'd' },
      { AF: 'q', AK: 'w', BF: 'e', BK: 'r' },
    ] as Lineup[]) {
      const pr = priceMatch(fitForLineup([], L), L, names);
      expect(Math.abs(pr.probs.A - pr.probs.B)).toBeLessThan(1e-9);
      const ms = pr.markets[0].selections;
      expect(ms[0].odds).toBe(ms[2].odds);
    }
  });
});

describe('olaylardan türetme', () => {
  it('mevki süreleri ve segmentler tutarlı', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const { match, events } = simulateMatch(truthParams(), { AF: 'ace', AK: 'wall', BF: 'mid1', BK: 'mid2' }, rng, { swapProb: 0.5 });
      const rt = roleTimes(match, events);
      for (const id of ['ace', 'wall', 'mid1', 'mid2']) expect(rt[id].F + rt[id].K).toBe(2 * HALF_MS);
      const seg = segmentsOf(match, events);
      const clockGoals = seg.segments.reduce((s, x) => s + x.goals.AF + x.goals.AK + x.goals.BF + x.goals.BK, 0);
      const f = deriveFacts(events);
      expect(clockGoals + seg.races.length).toBe(f.goalsA + f.goalsB);
      expect(seg.races.length).toBe(2);
    }
  });
  it('silinen gol sayılmaz', () => {
    const { events } = simulateMatch(truthParams(), { AF: 'ace', AK: 'wall', BF: 'mid1', BK: 'mid2' }, mulberry32(5));
    const before = deriveFacts(events);
    const g = events.find((e) => e.kind === 'goal')!;
    const after = deriveFacts(events.map((e) => (e === g ? { ...e, deleted_at: 'x' } : e)));
    expect(after.goalsA + after.goalsB).toBe(before.goalsA + before.goalsB - 1);
  });
});

describe('bahis sonuçlandırma', () => {
  const f = { goalsA: 3, goalsB: 3, htA: 2, htB: 1, playerGoals: { p1: 2, p3: 3, p2: 1 }, firstScorer: 'p1' };
  it('kurallar', () => {
    expect(settleRule({ k: 'ms', o: 'D' }, f)).toBe('won');
    expect(settleRule({ k: 'ms', o: 'A' }, f)).toBe('lost');
    expect(settleRule({ k: 'dc', o: ['A', 'D'] }, f)).toBe('won');
    expect(settleRule({ k: 'dc', o: ['A', 'B'] }, f)).toBe('lost');
    expect(settleRule({ k: 'ht', o: 'A' }, f)).toBe('won');
    expect(settleRule({ k: 'ou', line: 5.5, side: 'over' }, f)).toBe('won');
    expect(settleRule({ k: 'ou', line: 6.5, side: 'under' }, f)).toBe('won');
    expect(settleRule({ k: 'btts', yes: true }, f)).toBe('won');
    expect(settleRule({ k: 'pg', player: 'p4', yes: false }, f)).toBe('won');
    expect(settleRule({ k: 'pg', player: 'p2', yes: true }, f)).toBe('won');
    expect(settleRule({ k: 'pgl', player: 'p3', line: 2.5, side: 'over' }, f)).toBe('won');
    expect(settleRule({ k: 'pgl', player: 'p9', line: 0.5, side: 'under' }, f)).toBe('won');
    expect(settleRule({ k: 'fg', player: 'p1' }, f)).toBe('won');
    expect(settleRule({ k: 'fg', player: 'p1' }, { ...f, firstScorer: null })).toBe('void');
  });
});

describe('kura', () => {
  it('daha önce birlikte oynayanlar daha az eşleşir, renk/mevki rastgele', () => {
    const rng = mulberry32(99);
    const counts: Record<string, number> = {};
    let aIsP0 = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const l = drawTeams(['p0', 'p1', 'p2', 'p3'], { [pairKey('p0', 'p1')]: 2 }, rng);
      const k = [l.AF, l.AK].sort().join('');
      const other = [l.BF, l.BK].sort().join('');
      const key = [k, other].sort().join('/');
      counts[key] = (counts[key] ?? 0) + 1;
      if (l.AF === 'p0' || l.AK === 'p0') aIsP0++;
      expect(new Set([l.AF, l.AK, l.BF, l.BK]).size).toBe(4);
    }
    // p0-p1 ağırlığı 0,0625, diğer ikisi 1: oran ≈ 0.0625/2.0625
    expect(Math.abs(counts['p0p1/p2p3'] / N - 0.0625 / 2.0625)).toBeLessThan(0.01);
    expect(Math.abs(aIsP0 / N - 0.5)).toBeLessThan(0.02);
  });
});
