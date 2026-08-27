const STORAGE_KEY = 'tekon.sessionToken';

/**
 * Resolve the initial session token at app startup (F7-P0-01).
 *
 * `tekon ui` prints a URL with the session token in the fragment
 * (`/#token=<token>`). Browsers do not send the fragment in the HTTP request or
 * Referer, so it is a practical local bootstrap channel that avoids a manual
 * copy from `.tekon/web-session.json`. The token is still a long-lived,
 * JavaScript-readable credential: terminal scrollback and any same-origin XSS
 * remain relevant, so a one-time nonce / HttpOnly-cookie exchange is tracked as
 * separate security hardening rather than being implied by this helper.
 *
 * We persist the captured token to sessionStorage so a refresh keeps the
 * session, then remove the fragment with history.replaceState. sessionStorage
 * (not localStorage) keeps the value scoped to the tab and clears it when the
 * tab closes.
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
  // Preserve React Router's history metadata (idx/key/usr). Replacing it with
  // null makes the current entry look external and can break back/forward
  // semantics after bootstrap or a same-document token refresh.
  window.history.replaceState(window.history.state, '', pathname + search);
}
