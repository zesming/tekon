import React, { createContext, useContext, useState, useCallback } from 'react';
import type { ReactElement } from 'react';

import { setRpcSessionToken } from '../lib/rpc-client.js';

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

const SESSION_STORAGE_KEY = 'tekon-session-token';

/**
 * Provides authentication token.
 * Auto-reads ?token=xxx from URL on mount and persists to sessionStorage.
 */
export function AuthProvider({ children }: AuthProviderProps): ReactElement {
  const [token, setTokenState] = useState<string | null>(() => {
    // 1. Check URL ?token=xxx first (highest priority)
    if (typeof window !== 'undefined') {
      const urlToken = new URLSearchParams(window.location.search).get('token');
      if (urlToken) {
        sessionStorage.setItem(SESSION_STORAGE_KEY, urlToken);
        setRpcSessionToken(urlToken);
        // Clean the token from URL without reloading
        const url = new URL(window.location.href);
        url.searchParams.delete('token');
        window.history.replaceState({}, '', url.pathname + url.search);
        return urlToken;
      }
      // 2. Fall back to sessionStorage
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored) {
        setRpcSessionToken(stored);
        return stored;
      }
    }
    return null;
  });

  const setToken = useCallback((newToken: string | null) => {
    setRpcSessionToken(newToken);
    setTokenState(newToken);
    if (typeof window !== 'undefined') {
      if (newToken) {
        sessionStorage.setItem(SESSION_STORAGE_KEY, newToken);
      } else {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      }
    }
  }, []);

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
