import React, { createContext, useContext, useState, useCallback } from 'react';
import type { ReactElement } from 'react';

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
 */
export function AuthProvider({ children }: AuthProviderProps): ReactElement {
  const [token, setTokenState] = useState<string | null>(null);

  const setToken = useCallback((newToken: string | null) => {
    setTokenState(newToken);
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
