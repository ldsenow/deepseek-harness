/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--pairing-token`) and its
 * `--help` text, then provides the immutable values as
 * {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that service before
 * reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { PAIRING_TOKEN_PATTERN } from '@deepseek-ai/dsh-client-connection'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
  /** `--pairing-token`, absent when the invocation did not name one. */
  pairingToken?: string
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  pairingToken?: string
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable; requires --pairing-token)')
    .option('--pairing-token <token>', 'pairing token every non-loopback client must present (16+ characters of A-Za-z0-9_-)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0 --pairing-token <token>
                                             serve the LAN over TLS behind the pairing token
                                             (generate one: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
`)
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a usage error —
 * `--host 0.0.0.0` or `--trusted-host` without `--pairing-token`, a malformed
 * token, a non-numeric `--port` — rejects the invocation, so on rejection
 * (and on `--help`) nothing is provided. The /api surface executes code as
 * this process, so every path that admits non-loopback callers requires the
 * pairing token; the token itself is re-validated at the connection plugin's
 * load, and this parse-time check only turns that into a usage error.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    if (options.pairingToken !== undefined && !PAIRING_TOKEN_PATTERN.test(options.pairingToken)) {
      program.error('error: --pairing-token must be at least 16 characters of A-Za-z0-9_-')
    }
    if (options.host === '0.0.0.0' && options.pairingToken === undefined) {
      program.error('error: --host 0.0.0.0 exposes remote code execution to the network, so it requires --pairing-token; generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"')
    }
    if (options.trustedHost !== undefined && options.trustedHost.length > 0 && options.pairingToken === undefined) {
      program.error('error: --trusted-host requires --pairing-token — without a pairing token no non-loopback request is admitted')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
      ...options.pairingToken !== undefined && { pairingToken: options.pairingToken },
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
