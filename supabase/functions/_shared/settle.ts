// Bahis sonuçlandırma kuralları. Aynı mantık veritabanında (settle_rule SQL
// fonksiyonu) da vardır; testler ikisinin her durumda aynı sonucu verdiğini doğrular.

import type { BetResult, BetRule, MatchFacts, Outcome } from './types.ts';

function outcome(a: number, b: number): Outcome {
  return a > b ? 'A' : a < b ? 'B' : 'D';
}

export function settleRule(rule: BetRule, f: MatchFacts): BetResult {
  const won = (c: boolean): BetResult => (c ? 'won' : 'lost');
  switch (rule.k) {
    case 'ms':
      return won(outcome(f.goalsA, f.goalsB) === rule.o);
    case 'dc':
      return won(rule.o.includes(outcome(f.goalsA, f.goalsB)));
    case 'ht':
      return won(outcome(f.htA, f.htB) === rule.o);
    case 'ou': {
      const t = f.goalsA + f.goalsB;
      return won(rule.side === 'over' ? t > rule.line : t < rule.line);
    }
    case 'btts':
      return won((f.goalsA > 0 && f.goalsB > 0) === rule.yes);
    case 'pg':
      return won(((f.playerGoals[rule.player] ?? 0) > 0) === rule.yes);
    case 'pgl': {
      const g = f.playerGoals[rule.player] ?? 0;
      return won(rule.side === 'over' ? g > rule.line : g < rule.line);
    }
    case 'fg':
      if (f.firstScorer === null) return 'void';
      return won(f.firstScorer === rule.player);
  }
}

export function ruleText(rule: BetRule, name: (id: string) => string): string {
  const o = (x: Outcome) => (x === 'A' ? 'Mavi' : x === 'B' ? 'Kırmızı' : 'Beraberlik');
  switch (rule.k) {
    case 'ms':
      return `MS ${o(rule.o)}`;
    case 'dc':
      return `ÇŞ ${o(rule.o[0])} / ${o(rule.o[1])}`;
    case 'ht':
      return `İY ${o(rule.o)}`;
    case 'ou':
      return `${rule.line.toFixed(1).replace('.', ',')} ${rule.side === 'over' ? 'Üst' : 'Alt'}`;
    case 'btts':
      return `KG ${rule.yes ? 'Var' : 'Yok'}`;
    case 'pg':
      return `${name(rule.player)} gol ${rule.yes ? 'atar' : 'atamaz'}`;
    case 'pgl':
      return `${name(rule.player)} ${rule.line.toFixed(1).replace('.', ',')} gol ${rule.side === 'over' ? 'üst' : 'alt'}`;
    case 'fg':
      return `İlk gol: ${name(rule.player)}`;
  }
}
