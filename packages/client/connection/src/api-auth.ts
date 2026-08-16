/**
 * Pairing-token authentication for the /api request family: the fence in
 * [api-request-trust](./api-request-trust.ts) decides which authority a `Host`
 * addressed, this module decides whether a caller may act at all. The package
 * README carries the trust model; the trap it exists to avoid is deriving the
 * loopback exemption from `Host`, which any client reaching the socket forges.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { AUTH_COOKIE_NAME, PAIRING_TOKEN_PATTERN, PAIRING_TOKEN_REQUIREMENT } from './auth-wire.ts'
import { isTrustedApiRequest, header, type ApiTrustRequest } from './api-request-trust.ts'

/**
 * Assert one configured pairing token is strong enough to guard network
 * access: at least 16 characters of `A-Za-z0-9_-`. Anything else — too short,
 * cookie-breaking punctuation, non-ASCII — fails the load loudly instead of
 * silently weakening or corrupting the cookie exchange.
 * @param token - the configured value, verbatim.
 */
export function assertPairingToken(token: string): void {
  if (PAIRING_TOKEN_PATTERN.test(token)) return
  throw new Error(`client-connection: pairingToken must be ${PAIRING_TOKEN_REQUIREMENT}`)
}

/**
 * Resolve the deployment's pairing token from the credential reference its
 * configuration names. Configuration carries the reference, never the secret,
 * so config-echoing surfaces cannot leak it and the value can live in the
 * environment, the managed credential store, or a `.env` layer. Resolution is
 * once per load: admission is synchronous, and a rotated token takes effect on
 * the next boot.
 * @param ctx - plugin context; the credentials seam must be composed.
 * @param ref - environment-variable-shaped reference, or undefined for a loopback-only deployment.
 * @returns the token, or undefined when no reference was configured.
 */
export async function resolvePairingToken(ctx: Context, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(`client-connection: pairingTokenEnv ${JSON.stringify(ref)} needs the credentials service, which this composition does not provide`)
  }
  const hit = await credentials.resolve(credentialRef(ref))
  if (hit === undefined) {
    throw new Error(`client-connection: pairingTokenEnv names ${JSON.stringify(ref)}, which holds no value in the environment, the credential store, or a .env layer`)
  }
  assertPairingToken(hit.value)
  return hit.value
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
  if (!isTrustedApiRequest(request, trustedHosts)) return false
  if (peerIsLoopback) return true
  return pairingToken !== undefined
    && presentedTokens(request.headers).some(presented => tokenMatches(presented, pairingToken))
}
