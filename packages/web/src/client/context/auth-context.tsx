import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactElement } from 'react';

import { authScope } from '../lib/query-keys.js';
import { queryCache } from '../lib/query-cache.js';
import { setRpcSessionToken } from '../lib/rpc-client.js';
import {
  hashHasToken,
  persistToken,
  readTokenFromLocation,
  stripTokenFragment,
} from '../lib/session-bootstrap.js';

// ---------------------------------------------------------------------------
// Auth context types
// ---------------------------------------------------------------------------

interface AuthContextValue {
  token: string | null;
  setToken: (token: string | null) => void;
}

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// ---------------------------------------------------------------------------
// Auth provider
// ---------------------------------------------------------------------------

export interface AuthProviderProps {
  children: React.ReactNode;
  /**
   * Session token resolved at startup from the URL fragment / sessionStorage
   * (F7-P0-01). `main.tsx` computes it once and also seeds the RPC client, so
   * the initial state here matches what the first-paint RPC already sends.
   */
  initialToken?: string | null;
}

/**
 * Provides the session token, hydrated from the startup bootstrap
 * (`#token=` fragment → sessionStorage) so a page refresh keeps the session
 * within the tab (F7-P0-01). The token is persisted to sessionStorage on
 * change (tab-scoped; cleared when the tab closes) and mirrored into the RPC
 * client so authenticated reads and the SSE stream send `x-session-token`.
 *
 * When the token changes, the provider clears all query-cache entries and
 * in-flight requests that belong to the previous auth scope so that stale
 * data from the old session cannot leak into the new one.
 */
export function AuthProvider({
  children,
  initialToken = null,
}: AuthProviderProps): ReactElement {
  const [token, setTokenState] = useState<string | null>(initialToken);
  const prevScopeRef = useRef<string>(authScope(initialToken));

  const setToken = useCallback((newToken: string | null) => {
    setTokenState(newToken);
  }, []);

  // Capture both the initial bootstrap fragment and later same-document
  // fragment navigations. A user may paste a fresh `#token=` URL into an
  // already-open Tekon tab; browsers handle that as a hashchange rather than a
  // full reload, so a mount-only read would leave the old/null credential in
  // memory and the secret visible in the address bar. Seed the RPC client
  // synchronously before the React state update, then strip the fragment.
  useEffect(() => {
    const captureTokenFragment = () => {
      if (!hashHasToken()) return;
      const fragmentToken = readTokenFromLocation();
      if (fragmentToken) {
        setRpcSessionToken(fragmentToken);
        setTokenState(fragmentToken);
      }
      stripTokenFragment();
    };

    captureTokenFragment();
    window.addEventListener('hashchange', captureTokenFragment);
    return () => window.removeEventListener('hashchange', captureTokenFragment);
  }, []);

  // Detect actual token changes and evict old-session cache entries.
  useEffect(() => {
    const newScope = authScope(token);
    const oldScope = prevScopeRef.current;

    // Keep the RPC client's token in sync so authenticated (auth:'session')
    // procedures and the SSE client actually send x-session-token, and persist
    // it so a refresh keeps the session (F7-P0-01). main.tsx seeds the initial
    // token before first paint; this covers every later change (manual paste
    // in the TopBar, or clearing the token).
    setRpcSessionToken(token);
    persistToken(token);

    if (oldScope !== newScope) {
      // Hard-clear all entries that belonged to the previous scope.
      queryCache.clearByScope(oldScope);
      // Abort any in-flight requests so they cannot write stale data.
      queryCache.clearAllInFlight();
      prevScopeRef.current = newScope;
    }
  }, [token]);

  return (
    <AuthContext.Provider value={{ token, setToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// useAuth hook
// ---------------------------------------------------------------------------

/**
 * Hook to access authentication token and setter.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
