/**
 * Browser pairing bootstrap: adopt a pairing token from the page URL and keep
 * presenting it. A pairing link carries `#auth=<token>` in the URL fragment —
 * never sent to any server or written to server logs — which this bootstrap
 * moves into localStorage and strips from the address bar. Every boot then
 * republishes the stored token as the `dsh_auth` cookie (`SameSite=Strict`,
 * whole-origin path), which the browser attaches to /api fetches and
 * WebSocket upgrades alike, so the carriers need no token plumbing. Browser
 * only: without `location` and `localStorage` this is a no-op.
 */

import { AUTH_COOKIE_NAME, AUTH_FRAGMENT_PARAM, PAIRING_TOKEN_PATTERN } from '../auth-wire.ts'

/** localStorage key holding the adopted pairing token. */
export const AUTH_STORAGE_KEY = 'dsh.pairingToken'

/** The globals the bootstrap reads, typed for environments where any may be absent. */
interface BrowserAuthGlobals {
  location?: { hash: string; pathname: string; search: string; protocol: string }
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  document?: { cookie: string }
  history?: { replaceState(data: unknown, unused: string, url?: string): void }
}

/**
 * Adopt a `#auth=<token>` pairing fragment (store, then strip it from the
 * address bar, preserving any other fragment parameters) and republish the
 * stored token as the `dsh_auth` cookie. Storage or cookie access may throw
 * under browser privacy settings; the caller decides how to contain that.
 */
export function bootstrapAuthToken(): void {
  const globals = globalThis as BrowserAuthGlobals
  const pageLocation = globals.location
  const storage = globals.localStorage
  if (pageLocation === undefined || storage === undefined) return
  const fragment = new URLSearchParams(pageLocation.hash.replace(/^#/, ''))
  const fromFragment = fragment.get(AUTH_FRAGMENT_PARAM)
  if (fromFragment !== null) {
    // The fragment is attacker-reachable input and storage is durable, so only
    // a well-formed token is adopted; a malformed one is dropped rather than
    // stored, and never reaches the cookie attribute string it could otherwise
    // extend with its own `;` clauses. The address bar is stripped either way.
    if (PAIRING_TOKEN_PATTERN.test(fromFragment)) storage.setItem(AUTH_STORAGE_KEY, fromFragment)
    fragment.delete(AUTH_FRAGMENT_PARAM)
    const rest = fragment.toString()
    globals.history?.replaceState(null, '', `${pageLocation.pathname}${pageLocation.search}${rest === '' ? '' : `#${rest}`}`)
  }
  const token = storage.getItem(AUTH_STORAGE_KEY)
  if (token === null || !PAIRING_TOKEN_PATTERN.test(token) || globals.document === undefined) return
  // Secure on an https page (every network deployment serves TLS), so the
  // token cookie never rides a plaintext request; loopback http keeps working.
  const secure = pageLocation.protocol === 'https:' ? '; Secure' : ''
  globals.document.cookie = `${AUTH_COOKIE_NAME}=${token}; path=/; SameSite=Strict${secure}`
}
