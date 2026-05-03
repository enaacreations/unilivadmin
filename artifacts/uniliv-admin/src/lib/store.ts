import { create } from 'zustand';

interface AuthState {
  token: string | null;
  setToken: (token: string | null) => void;
  isAuthenticated: () => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('uniliv_token'),
  setToken: (token) => {
    if (token) {
      localStorage.setItem('uniliv_token', token);
    } else {
      localStorage.removeItem('uniliv_token');
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
