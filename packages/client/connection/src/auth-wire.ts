/**
 * Wire constants of the pairing-token exchange, shared by the browser half
 * (which stores and presents the token) and the node half (which verifies it).
 * Browser-safe: no Node imports.
 */

/** Cookie the browser client sets after pairing; sent on /api fetches and WebSocket upgrades alike. */
export const AUTH_COOKIE_NAME = 'dsh_auth'

/** URL-fragment parameter carrying the token on a pairing link (`#auth=<token>`); the fragment never reaches the server or its logs. */
export const AUTH_FRAGMENT_PARAM = 'auth'

/** Accepted token form: URL-, cookie-, and shell-safe characters with enough length for real entropy. */
export const PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}$/
