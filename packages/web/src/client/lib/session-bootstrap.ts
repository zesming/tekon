const STORAGE_KEY = 'tekon.sessionToken';

/**
 * Resolve the initial session token at app startup (F7-P0-01).
 *
 * `tekon ui` prints a URL with the session token in the fragment
 * (`/#token=<token>`). The fragment is never sent to the server (no Referer,
 * no request URL, no server log), so it is a safe local-single-machine channel
 * to hand the static `.tekon/web-session.json` token to the browser without
 * the user hand-copying it. We read it once, persist to sessionStorage so a
 * refresh keeps the session, and the caller strips the fragment via
 * history.replaceState. sessionStorage (not localStorage) means the token is
 * scoped to the tab and cleared when the tab closes.
 *
 * A one-time-consumable nonce exchange (to also keep the token out of shell
 * history / the address bar) is a separate security hardening tracked in a
 * follow-up PR/ADR; this closes the "default Web entry is unusable" blocker.
 */
export function readTokenFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (hash.length > 1) {
    const fromHash = new URLSearchParams(hash.slice(1)).get('token');
    if (fromHash) return fromHash;
  }
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist (or clear) the session token in sessionStorage. */
export function persistToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.sessionStorage.setItem(STORAGE_KEY, token);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures (private mode / disabled): the in-memory token
    // still works for the current page; only refresh-persistence is lost.
  }
}

/** True when the current URL fragment carries a bootstrap token. */
export function hashHasToken(): boolean {
  if (typeof window === 'undefined') return false;
  const hash = window.location.hash;
  return hash.length > 1 && !!new URLSearchParams(hash.slice(1)).get('token');
}

/** Remove the token fragment from the address bar without a navigation. */
export function stripTokenFragment(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search } = window.location;
  window.history.replaceState(null, '', pathname + search);
}
