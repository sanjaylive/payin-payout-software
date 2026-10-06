import { create } from 'zustand';

/**
 * Access token lives in memory only (never localStorage) so XSS can't exfiltrate a persistent
 * credential. The long-lived refresh token is an httpOnly cookie the browser JS cannot read.
 * This is one of the few genuinely global client states, hence Zustand.
 */
interface AuthState {
  accessToken: string | null;
  setAccessToken: (token: string) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  setAccessToken: (accessToken) => set({ accessToken }),
  clear: () => set({ accessToken: null }),
}));
