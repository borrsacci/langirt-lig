import { create } from 'zustand';

export type Tab = 'match' | 'coupons' | 'stats' | 'ranks' | 'profile';
const initial = (() => {
  try {
    const t = new URLSearchParams(location.search).get('tab');
    return (['match', 'coupons', 'stats', 'ranks', 'profile'] as Tab[]).includes(t as Tab) ? (t as Tab) : 'match';
  } catch {
    return 'match' as Tab;
  }
})();

/** Hangi sekmenin açık olduğu (bildirime dokununca ilgili sekmeye gitmek için global) */
export const useNav = create<{ tab: Tab; go: (t: Tab) => void }>((set) => ({ tab: initial, go: (tab) => set({ tab }) }));
