/**
 * The web app's TLS-material provider: on a network-serving invocation it
 * ensures a persistent self-signed certificate exists and provides its PEM
 * file paths as {@link WEB_TLS_SERVICE}; a loopback invocation provides no
 * paths, keeping local serving on plain HTTP. The webserver row injects the
 * service and reads only paths, so key material never enters plugin config or
 * the surfaces that echo it (inventory, diagnostics). The certificate is
 * generated once and reused across restarts so a device's accept-once
 * exception stays valid; its subject alternative names carry the loopback
 * names plus the LAN addresses sampled at generation, and a later address
 * change only re-prompts the browser warning, never breaks serving.
 * @module @deepseek-ai/dsh-web-app/tls
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { generate } from 'selfsigned'
import { resolveLanTrust } from './index.ts'

/** Stable Cordis plugin name. */
export const name = 'web-tls'

/** Service provided by this ordinary plugin and injected by the webserver row. */
export const WEB_TLS_SERVICE = 'webTls'

/** What the webserver row reads from {@link WEB_TLS_SERVICE}. */
export interface WebTlsValues {
  /** PEM file paths of the active material; absent on a loopback-only (plain HTTP) deployment. */
  paths?: { certPath: string; keyPath: string }
}

/** Services required before the invocation's bind host is known. */
export const inject = ['webStartup']

/** Plugin config: whether this invocation serves the network, and where the material persists. */
export interface Config {
  /** Serve TLS: true exactly when the composition binds all interfaces. */
  enabled: boolean
  /** Directory holding the generated `cert.pem` and `key.pem`. */
  dir: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
  dir: z.string().required(),
})

/** Certificate validity in milliseconds (10 years): long enough that a paired device's accepted exception outlives the install. */
const CERT_VALIDITY_MS = 3650 * 24 * 60 * 60 * 1000

/**
 * Provide the TLS paths, generating the self-signed material on first
 * network-serving boot. Generation or an unwritable directory rejects the
 * load: a composition that asked for TLS must never silently serve plaintext.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) {
    ctx.provide(WEB_TLS_SERVICE, {} satisfies WebTlsValues)
    return
  }
  const certPath = join(config.dir, 'cert.pem')
  const keyPath = join(config.dir, 'key.pem')
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    // Owner-only on POSIX so the private key's directory is not world-traversable
    // on a shared host; Windows ACLs ignore mode, matching other dsh-home dirs.
    mkdirSync(config.dir, { recursive: true, mode: 0o700 })
    const pems = await generate([{ name: 'commonName', value: 'dsh' }], {
      notAfterDate: new Date(Date.now() + CERT_VALIDITY_MS),
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          ...resolveLanTrust('0.0.0.0', []).lanAddresses.map(ip => ({ type: 7 as const, ip })),
        ],
      }],
    })
    writeFileSync(certPath, pems.cert)
    // Owner-only on POSIX; Windows ACLs ignore mode, matching other dsh-home files.
    writeFileSync(keyPath, pems.private, { mode: 0o600 })
  }
  ctx.provide(WEB_TLS_SERVICE, { paths: { certPath, keyPath } } satisfies WebTlsValues)
}
