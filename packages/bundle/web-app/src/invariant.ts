/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-web-app`.
 * @module @deepseek-ai/dsh-web-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-web-app'

/** Cordis companion plugin name. */
export const name = 'web-app-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: every contribution (frontend-static child plugin,
 * prompt section, bashEnv registration) is registry-disposed with the fiber,
 * and each owning registry's package carries that relation's invariant. The
 * two pieces of state this package does own are unobservable from here: the
 * sleep-inhibitor child is held in `keep-awake`'s effect closure and settles
 * during that disposer, before any invariant pass could read it, and the TLS
 * material is a file pair whose only runtime relation — the server serving
 * the same certificate it generated — belongs to the webserver's own
 * invariant, which already probes the bound listener.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
