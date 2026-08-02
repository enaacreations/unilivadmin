import { create } from 'zustand';
import { setToken as setApiToken } from '@/lib/api-fetch';

interface AuthState {
  token: string | null;
  setToken: (token: string | null, remember?: boolean) => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // The access token lives in memory only — never persisted to web storage (XSS exfil risk).
  // On a full page reload this starts null and is rehydrated from the httpOnly refresh cookie
  // (see bootstrapAuth() in main.tsx). The httpOnly cookie is the source of truth across reloads.
  token: null,
  setToken: (token, remember = true) => {
    // Mirror the token into the api-fetch in-memory holder so apiFetch/apiDownload and the
    // generated api-client bearer getter all read the same value.
    setApiToken(token);
    if (token) {
      // "Remember me" no longer gates token persistence (we never persist it). It is kept only
      // as a server-side hint for the refresh-cookie lifetime; record the choice so the
      // login → /api/auth/login request can pass it along.
      localStorage.setItem('uniliv_remember', remember ? '1' : '0');
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
