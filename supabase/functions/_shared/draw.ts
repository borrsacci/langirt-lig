// Kura: eski uygulamayla birebir aynı algoritma.
// 4 oyuncunun 3 olası ikili eşleşmesinden biri seçilir; daha önce birlikte oynamış
// ikililerin ağırlığı her ortak maç için 0,25 ile çarpılır (tekrar eden eşleşmeler
// az çıkar). Sonra takımların rengi ve her takımın içinde kim kaleci kim forvet
// rastgele belirlenir.

import { type Lineup, pairKey } from './types.ts';

export type Rng = () => number;

export function drawTeams(players: string[], pairCounts: Record<string, number>, rng: Rng = Math.random): Lineup {
  if (players.length !== 4 || new Set(players).size !== 4) throw new Error('Kura için 4 farklı oyuncu gerekli');
  const p = players;
  const combos: [[string, string], [string, string]][] = [
    [[p[0], p[1]], [p[2], p[3]]],
    [[p[0], p[2]], [p[1], p[3]]],
    [[p[0], p[3]], [p[1], p[2]]],
  ];
  const cnt = (a: string, b: string) => pairCounts[pairKey(a, b)] ?? 0;
  const weights = combos.map(([t1, t2]) => Math.pow(0.25, cnt(t1[0], t1[1]) + cnt(t2[0], t2[1])));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  let idx = combos.length - 1;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      idx = i;
      break;
    }
  }
  const [c1, c2] = combos[idx];
  const [ta, tb] = rng() > 0.5 ? [c2, c1] : [c1, c2];
  const aKeeperFirst = rng() > 0.5;
  const bKeeperFirst = rng() > 0.5;
  return {
    AK: aKeeperFirst ? ta[0] : ta[1],
    AF: aKeeperFirst ? ta[1] : ta[0],
    BK: bKeeperFirst ? tb[0] : tb[1],
    BF: bKeeperFirst ? tb[1] : tb[0],
  };
}
