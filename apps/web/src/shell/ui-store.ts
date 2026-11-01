import { create } from 'zustand';

export type ThemePref = 'system' | 'light' | 'dark';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* per-viewer convenience only */
  }
}

export function applyTheme(theme: ThemePref) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

interface UiState {
  theme: ThemePref;
  navCollapsed: boolean;
  mobileNavOpen: boolean;
  assistantOpen: boolean;
  setTheme: (t: ThemePref) => void;
  setNavCollapsed: (v: boolean) => void;
  setMobileNavOpen: (v: boolean) => void;
  setAssistantOpen: (v: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  theme: read('pg.theme', ['system', 'light', 'dark'] as const, 'system'),
  // A versioned preference lets the redesigned navigation open once for returning viewers.
  // They can still collapse it again and that choice remains persistent.
  navCollapsed: read('pg.nav.v2', ['0', '1'] as const, '0') === '1',
  mobileNavOpen: false,
  assistantOpen: false,
  setTheme: (theme) => {
    write('pg.theme', theme);
    applyTheme(theme);
    set({ theme });
  },
  setNavCollapsed: (navCollapsed) => {
    write('pg.nav.v2', navCollapsed ? '1' : '0');
    set({ navCollapsed });
  },
  setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
}));
