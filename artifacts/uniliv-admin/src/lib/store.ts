import { create } from 'zustand';

interface AuthState {
  token: string | null;
  setToken: (token: string | null, remember?: boolean) => void;
  isAuthenticated: () => boolean;
}

const TOKEN_KEY = 'uniliv_token';

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem(TOKEN_KEY) ?? sessionStorage.getItem(TOKEN_KEY),
  setToken: (token, remember = true) => {
    if (token) {
      // "Remember me": localStorage survives a browser restart; sessionStorage clears on close.
      const primary = remember ? localStorage : sessionStorage;
      const secondary = remember ? sessionStorage : localStorage;
      primary.setItem(TOKEN_KEY, token);
      secondary.removeItem(TOKEN_KEY);
      localStorage.setItem('uniliv_remember', remember ? '1' : '0');
    } else {
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_KEY);
    }
    set({ token });
  },
  isAuthenticated: () => !!get().token,
}));

interface AppState {
  propertyId: string | null;
  setPropertyId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  propertyId: null,
  setPropertyId: (id) => set({ propertyId: id }),
}));
