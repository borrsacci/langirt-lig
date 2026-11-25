import { it } from 'vitest';
import { drawTeams } from '../supabase/functions/_shared/draw.ts';
import { emptyParams, fitForLineup, fitModel, type ModelParams } from '../supabase/functions/_shared/model.ts';
import { priceMatch } from '../supabase/functions/_shared/pricing.ts';
import { normal } from '../supabase/functions/_shared/rng.ts';
import { pairKey } from '../supabase/functions/_shared/types.ts';
import { mulberry32, simulateMatch } from './sim.ts';
it.skipIf(!process.env.CALIB)('kalibrasyon', () => {
  const res: Record<string, number[]> = {};
  let tPrice = 0, nPrice = 0;
  for (let world = 0; world < 6; world++) {
    const rng = mulberry32(1000 + world);
    const ids = Array.from({ length: 10 }, (_, i) => 'p' + i);
    const truth: ModelParams = emptyParams();
    for (const id of ids) truth.players[id] = { g: 0.25 * normal(rng), aF: 0.2 * normal(rng), aK: 0.2 * normal(rng), dF: 0.2 * normal(rng), dK: 0.2 * normal(rng) };
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) truth.pairs[pairKey(ids[i], ids[j])] = 0.1 * normal(rng);
    const all = [];
    for (let i = 0; i < 400; i++) { const pool = [...ids].sort(() => rng() - 0.5).slice(0, 4); all.push(simulateMatch(truth, drawTeams(pool, {}, rng), rng, { swapProb: 0.2 })); }
    for (const n of [0, 10, 30, 100, 400]) {
      const recs = all.slice(0, n);
      const map = fitModel(recs);
      for (let k = 0; k < 40; k++) {
        const pool = [...ids].sort(() => rng() - 0.5).slice(0, 4);
        const l = drawTeams(pool, {}, rng);
        const t = priceMatch(truth, l, x => x).probs;
        const t0 = Date.now();
        const lap = priceMatch(fitForLineup(recs, l), l, x => x).probs;
        tPrice += Date.now() - t0; nPrice++;
        const e2 = priceMatch(map, l, x => x).probs;
        const kl = (e: typeof t) => t.A * Math.log(t.A / e.A) + t.D * Math.log(t.D / e.D) + t.B * Math.log(t.B / e.B);
        (res[`map_${n}`] ??= []).push(kl(e2));
        (res[`post_${n}`] ??= []).push(kl(lap));
      }
    }
  }
  for (const [k, v] of Object.entries(res)) console.log(k, 'KL', (v.reduce((a, b) => a + b) / v.length).toFixed(4));
  console.log('fit+fiyat ort. ms', (tPrice / nPrice).toFixed(0));
}, 900000);
