import { useAuth } from '../context/auth-context.js';
import { authScope } from '../lib/query-keys.js';

/**
 * React hook that returns the current auth scope string derived from the
 * authentication token. The scope changes whenever the token changes,
 * ensuring that query-cache keys are automatically partitioned by session.
 */
export function useAuthScope(): string {
  const { token } = useAuth();
  return authScope(token);
}
