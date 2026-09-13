import type { ReactNode } from 'react';

export type AuthUser = {
  id?: number | string;
  username: string;
  /**
   * Optional human name configured in Settings → Profile. Server-normalised
   * from the `display_name` column; null when the user has not set one.
   */
  displayName?: string | null;
  [key: string]: unknown;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

/**
 * Which listener served this page: `local` (bearer token kept by the client)
 * or `remote` (Remote Gateway, HttpOnly cookie session only; FT-M08).
 */
export type AuthTransport = 'local' | 'remote';

export type AuthStatusPayload = {
  needsSetup?: boolean;
  transport?: AuthTransport;
};

export type RemotePairingPayload = {
  data?: { user?: AuthUser; session?: { sessionId: string; expiresAt: string } };
  error?: { code?: string; message?: string };
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  transport: AuthTransport;
  isLoading: boolean;
  needsSetup: boolean;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  /** Remote Gateway only: password + one-time pairing code issued from an already signed-in session. */
  pairRemote: (username: string, password: string, pairingCode: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  refreshOnboardingStatus: () => Promise<void>;
  /** Re-reads `/api/auth/user` so identity surfaces stay in sync after a save. */
  refreshUser: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
