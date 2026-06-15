import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { ReactElement } from 'react';

import { authScope } from '../lib/query-keys.js';
import { queryCache } from '../lib/query-cache.js';

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
}

/**
 * Provides authentication token in memory only (no sessionStorage).
 *
 * When the token changes, the provider clears all query-cache entries and
 * in-flight requests that belong to the previous auth scope so that stale
 * data from the old session cannot leak into the new one.
 */
export function AuthProvider({ children }: AuthProviderProps): ReactElement {
  const [token, setTokenState] = useState<string | null>(null);
  const prevScopeRef = useRef<string>(authScope(null));

  const setToken = useCallback((newToken: string | null) => {
    setTokenState(newToken);
  }, []);

  // Detect actual token changes and evict old-session cache entries.
  useEffect(() => {
    const newScope = authScope(token);
    const oldScope = prevScopeRef.current;

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
