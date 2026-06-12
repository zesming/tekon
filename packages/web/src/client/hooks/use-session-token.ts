import { useAuth } from '../context/auth-context.js';

/**
 * React hook to read/write the session token from AuthContext.
 *
 * @returns Token value and setter function
 */
export function useSessionToken(): {
  token: string | null;
  setToken: (token: string | null) => void;
} {
  const { token, setToken } = useAuth();
  return { token, setToken };
}
