import { useContext, useMemo } from 'react';

import { AuthContext } from '../components/auth/context/AuthContext';
import { resolveAppUserIdentity, type AppUserIdentity } from '../shared/identity';

/**
 * The app user's identity, derived once for every surface that shows it.
 *
 * Settings → Profile and the sidebar both read this hook, so their avatar
 * initial and display name can never drift apart. Reads the context directly
 * (rather than `useAuth`) so a surface rendered outside an `AuthProvider`
 * degrades to the generic fallback instead of throwing.
 */
export function useAppUserIdentity(): AppUserIdentity {
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;

  return useMemo(() => resolveAppUserIdentity(user), [user]);
}
