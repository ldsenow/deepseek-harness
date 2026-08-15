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

import { AUTH_COOKIE_NAME, AUTH_FRAGMENT_PARAM } from '../auth-wire.ts'

/** localStorage key holding the adopted pairing token. */
export const AUTH_STORAGE_KEY = 'dsh.pairingToken'

/** The globals the bootstrap reads, typed for environments where any may be absent. */
interface BrowserAuthGlobals {
  location?: { hash: string; pathname: string; search: string }
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
    storage.setItem(AUTH_STORAGE_KEY, fromFragment)
    fragment.delete(AUTH_FRAGMENT_PARAM)
    const rest = fragment.toString()
    globals.history?.replaceState(null, '', `${pageLocation.pathname}${pageLocation.search}${rest === '' ? '' : `#${rest}`}`)
  }
  const token = storage.getItem(AUTH_STORAGE_KEY)
  if (token === null || globals.document === undefined) return
  globals.document.cookie = `${AUTH_COOKIE_NAME}=${token}; path=/; SameSite=Strict`
}
