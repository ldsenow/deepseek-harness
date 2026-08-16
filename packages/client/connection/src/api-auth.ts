/**
 * Pairing-token authentication for the /api request family. The browser-trust
 * fence ([api-request-trust](./api-request-trust.ts)) decides only which
 * authority a request's `Host` addressed (DNS-rebinding and cross-site
 * defense); this module decides whether a network caller may act at all. A
 * request from a non-loopback peer is admitted only when the deployment
 * configured a pairing token and the request presents it — as the `dsh_auth`
 * cookie the browser client sets after pairing (sent on fetches and WebSocket
 * upgrades alike), or an `Authorization: Bearer` header for non-browser
 * clients. Only a genuine loopback peer skips the token: a local process
 * already owns the machine this server executes on. Loopback comes from the
 * socket peer address (`isLoopbackAddress`, [dsh-loopback](../../../util/loopback/README.md)), never the
 * client-controlled `Host` header — on an all-interfaces bind any client that
 * can reach the socket may claim `Host: localhost`, so a header-based
 * exemption would be a token bypass. Comparison is constant-time over digests,
 * so neither token length nor a matching prefix leaks through timing.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { AUTH_COOKIE_NAME, PAIRING_TOKEN_PATTERN } from './auth-wire.ts'
import { classifyApiRequest, header, type ApiTrustRequest } from './api-request-trust.ts'

/**
 * Assert one configured pairing token is strong enough to guard network
 * access: at least 16 characters of `A-Za-z0-9_-`. Anything else — too short,
 * cookie-breaking punctuation, non-ASCII — fails the load loudly instead of
 * silently weakening or corrupting the cookie exchange.
 * @param token - the configured value, verbatim.
 */
export function assertPairingToken(token: string): void {
  if (PAIRING_TOKEN_PATTERN.test(token)) return
  throw new Error('client-connection: pairingToken must be at least 16 characters of A-Za-z0-9_-')
}

/** Every token the request presents: the Bearer authorization plus each `dsh_auth` cookie value. */
function presentedTokens(headers: ApiTrustRequest['headers']): string[] {
  const tokens: string[] = []
  const authorization = header(headers, 'authorization')
  if (authorization?.startsWith('Bearer ') === true) tokens.push(authorization.slice('Bearer '.length))
  const cookies = header(headers, 'cookie')
  if (cookies !== undefined) {
    for (const pair of cookies.split(';')) {
      const separator = pair.indexOf('=')
      if (separator === -1) continue
      if (pair.slice(0, separator).trim() === AUTH_COOKIE_NAME) tokens.push(pair.slice(separator + 1).trim())
    }
  }
  return tokens
}

/** Constant-time equality over sha256 digests: length-independent, prefix-blind. */
function tokenMatches(presented: string, token: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(token).digest(),
  )
}

/**
 * Decide whether one /api-family request may reach its handler: the Host fence
 * first (rebinding and cross-site defense, applied to every request including
 * loopback peers so a rebound local browser is still refused), then
 * pairing-token authentication for every non-loopback peer. The tokenless
 * exemption is granted only to a genuine loopback peer — never on the basis of
 * a loopback-looking `Host`, which a non-loopback caller can forge.
 * @param request - Node HTTP or Fetch request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @param pairingToken - the deployment's pairing token; absent means no non-loopback request is admitted.
 * @param peerIsLoopback - whether the socket peer is loopback (`isLoopbackAddress`).
 * @returns true for an admitted request: Host-fence-accepted and, beyond a loopback peer, authenticated.
 */
export function admitApiRequest(
  request: ApiTrustRequest,
  trustedHosts: readonly string[],
  pairingToken: string | undefined,
  peerIsLoopback: boolean,
): boolean {
  if (classifyApiRequest(request, trustedHosts) === 'refused') return false
  if (peerIsLoopback) return true
  return pairingToken !== undefined
    && presentedTokens(request.headers).some(presented => tokenMatches(presented, pairingToken))
}
