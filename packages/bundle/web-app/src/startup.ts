/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--trusted-host`, `--pairing-token-env`,
 * `--pairing-token`, `--keep-awake`) and its `--help` text, then provides the
 * immutable values as {@link WEB_STARTUP_SERVICE}. Ordinary rows inject that
 * service before reading it from lazy config.
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
  /**
   * The resolved pairing token — from `--pairing-token-env`'s variable or the
   * literal `--pairing-token` — absent when the invocation named neither.
   */
  pairingToken?: string
  /** `--keep-awake`, absent when the invocation did not name it. */
  keepAwake?: boolean
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  trustedHost?: string[]
  pairingTokenEnv?: string
  pairingToken?: string
  keepAwake?: boolean
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
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable; requires a pairing token)')
    .option('--pairing-token-env <name>', 'environment variable holding the pairing token every non-loopback client must present (16+ characters of A-Za-z0-9_-)')
    .option('--pairing-token <token>', 'the pairing token itself; readable by every local user through the process argument list, so prefer --pairing-token-env')
    .option('--keep-awake', 'hold the platform sleep inhibitor while dsh serves, so idle sleep cannot cut off sessions or paired devices')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  DSH_PAIRING_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))") \\
    dsh --profile web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
                                             serve the LAN over TLS behind the pairing token
`)
}

/** How to generate a pairing token, appended to the errors that demand one. */
const GENERATE_TOKEN_HINT = 'generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'base64url\'))"'

/**
 * Resolve the invocation's pairing token from whichever form it named. The two
 * forms are mutually exclusive, and the referenced variable must hold a value:
 * a name that resolves to nothing would otherwise leave the deployment
 * silently loopback-only, or fail much later at the connection plugin's load
 * with no mention of the variable that was empty.
 * @param options - the parsed flag family.
 * @param program - the command, whose `error` exits with a usage message.
 * @param env - the process environment the variable is read from.
 * @returns the token, or undefined when this invocation named neither form.
 */
function resolvePairingToken(options: WebOptions, program: Command, env: NodeJS.ProcessEnv): string | undefined {
  if (options.pairingTokenEnv !== undefined && options.pairingToken !== undefined) {
    program.error('error: pass either --pairing-token-env or --pairing-token, not both')
  }
  if (options.pairingTokenEnv === undefined) return options.pairingToken
  const fromEnv = env[options.pairingTokenEnv]
  if (fromEnv === undefined || fromEnv === '') {
    program.error(`error: --pairing-token-env names ${JSON.stringify(options.pairingTokenEnv)}, which is not set; ${GENERATE_TOKEN_HINT}`)
  }
  return fromEnv
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service. The
 * command's action publishes the flags this invocation named; a usage error —
 * `--host 0.0.0.0` or `--trusted-host` without a pairing token, both token
 * forms at once, an empty referenced variable, a malformed token, a non-numeric
 * `--port` — rejects the invocation, so on rejection (and on `--help`) nothing
 * is provided. The /api surface executes code as this process, so every path
 * that admits non-loopback callers requires the pairing token; the token itself
 * is re-validated at the connection plugin's load, and this parse-time check
 * only turns that into a usage error.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = webCommand()
  program.action(() => {
    const options = program.opts<WebOptions>()
    const pairingToken = resolvePairingToken(options, program, process.env)
    if (pairingToken !== undefined && !PAIRING_TOKEN_PATTERN.test(pairingToken)) {
      program.error('error: the pairing token must be at least 16 characters of A-Za-z0-9_-')
    }
    if (options.host === '0.0.0.0' && pairingToken === undefined) {
      program.error(`error: --host 0.0.0.0 exposes remote code execution to the network, so it requires --pairing-token-env; ${GENERATE_TOKEN_HINT}`)
    }
    if (options.trustedHost !== undefined && options.trustedHost.length > 0 && pairingToken === undefined) {
      program.error('error: --trusted-host requires a pairing token — without one no non-loopback request is admitted')
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
    }
    ctx.provide(WEB_STARTUP_SERVICE, {
      ...options.host !== undefined && { host: options.host },
      ...options.port !== undefined && { port: Number(options.port) },
      trustedHosts: options.trustedHost ?? [],
      ...pairingToken !== undefined && { pairingToken },
      ...options.keepAwake === true && { keepAwake: true },
    } satisfies WebStartupValues)
  })
  parseCmdline(ctx, program)
}
