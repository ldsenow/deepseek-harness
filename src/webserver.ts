/**
 * The gated carrier: a `WebServer` subclass adding pairing-token admission and
 * TLS without any change to the harness.
 *
 * Every consumer registers its routes through `ctx.webServer.register` and
 * `registerUpgrade`, so wrapping those two methods puts admission in front of
 * every route the composition serves — including `/api`, which
 * `dsh-client-connection` registers verbatim and which therefore needs no
 * modification.
 *
 * TLS is terminated here and the decrypted socket is handed to the inherited
 * HTTP server, which preserves `req.socket.remoteAddress` as the real client
 * address. That is the property admission depends on: a TCP-forwarding proxy
 * would make every request read as a loopback peer and silently disable the
 * token gate entirely.
 * @module
 */

import { createServer as createTlsServer } from 'node:tls'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server as TlsServer } from 'node:tls'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { admit, assertPairingToken, isLoopbackAddress } from './admission.ts'

/** Endpoints pinned to a loopback peer even for an authenticated caller. */
const PRIVILEGED_METHODS = new Set([
  'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
  'host.pickDirectory', 'host.openPath',
  'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'llm.discoverModels',
])

/**
 * Typert Gateway namespaces a paired device may reach. The Gateway claims every
 * `namespace/method` a live remote service exposes, so this space grows with the
 * composition; anything unlisted is loopback-only, which keeps a service this
 * build has never seen from becoming LAN-reachable merely by appearing.
 */
const PAIRED_NAMESPACES = new Set(['commands', 'goals', 'messageFeedback'])

/** Routes served without admission: the browser must load the shell before it holds a token. */
const DEFAULT_PUBLIC_PATHS = ['/plugins']

/** Gated carrier config: the upstream listen fields plus this plugin's own. */
export interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** The resolved pairing token; absent keeps the carrier loopback-only. */
  pairingToken?: string
  /** PEM certificate path; set with {@link tlsKeyPath} to serve HTTPS. */
  tlsCertPath?: string
  /** PEM private-key path — a path, never inline material, so config surfaces cannot carry the key. */
  tlsKeyPath?: string
  /** Route paths served without admission; defaults to the client-bundle prefix. */
  publicPaths?: string[]
}

export const Config: z<Config> = z.object({
  host: z.union([z.const('127.0.0.1'), z.const('0.0.0.0')]).required(),
  port: z.natural().max(65535).required(),
  pairingToken: z.string(),
  tlsCertPath: z.string(),
  tlsKeyPath: z.string(),
  publicPaths: z.array(String).default(DEFAULT_PUBLIC_PATHS),
})

/**
 * Whether an `/api` endpoint stays pinned to a loopback peer. Dot-form API
 * Proxy methods are named individually; the Gateway's slash form is decided by
 * namespace, so a method added to an unlisted namespace inherits the pin rather
 * than defaulting to reachable.
 * @param endpoint - endpoint identity, either `method` or `namespace/method`.
 * @returns true when only a loopback peer may reach it.
 */
export function isPrivilegedEndpoint(endpoint: string): boolean {
  if (PRIVILEGED_METHODS.has(endpoint)) return true
  const separator = endpoint.indexOf('/')
  return separator !== -1 && !PAIRED_NAMESPACES.has(endpoint.slice(0, separator))
}

/** The endpoint an `/api` request addresses, or undefined when its path carries none. */
function endpointOf(pathname: string): string | undefined {
  if (!pathname.startsWith('/api/')) return undefined
  const rest = pathname.slice('/api/'.length)
  return rest.length > 0 ? rest : undefined
}

/**
 * The inherited HTTP server. `WebServer` declares this field `private`, which
 * TypeScript erases at runtime, so a subclass can still reach it — but a rename
 * upstream would otherwise surface as a silent loss of TLS. {@link assertServer}
 * turns that into a loud load failure instead.
 */
function assertServer(candidate: unknown): Server {
  const server = candidate as Server | undefined
  if (server === undefined || typeof server.emit !== 'function') {
    throw new Error(
      'lanyard: the inherited WebServer no longer exposes its node:http server, so TLS cannot be terminated '
      + 'in front of it; this plugin needs updating for this @deepseek-ai/dsh-host-webserver version',
    )
  }
  return server
}

export class GatedWebServer extends WebServer {
  static override Config: z<Config> = Config

  private readonly gate: Config
  private tls: TlsServer | undefined
  private tlsPort: number | undefined

  constructor(ctx: Context, config: Config) {
    // With TLS the inherited server must not own the public port: this class
    // binds it and forwards decrypted sockets, so the parent gets an ephemeral
    // loopback socket whose only role is to route what TLS hands it.
    const servesTls = config.tlsCertPath !== undefined && config.tlsKeyPath !== undefined
    super(ctx, servesTls ? { host: '127.0.0.1', port: 0 } : { host: config.host, port: config.port })
    if (config.pairingToken !== undefined) assertPairingToken(config.pairingToken)
    if ((config.tlsCertPath === undefined) !== (config.tlsKeyPath === undefined)) {
      throw new Error('lanyard: tlsCertPath and tlsKeyPath must be configured together')
    }
    if (config.host === '0.0.0.0' && config.pairingToken === undefined) {
      throw new Error(
        'lanyard: an all-interfaces bind requires a pairing token, because the /api surface runs commands as this process',
      )
    }
    this.gate = config
  }

  /** The port clients reach: the TLS listener when serving HTTPS, else the inherited one. */
  override get port(): number {
    return this.tlsPort ?? super.port
  }

  /** The configured bind host, which TLS mode does not delegate to the inherited server. */
  override get host(): Config['host'] {
    return this.gate.host
  }

  /** URL scheme this carrier answers. */
  override get scheme(): 'http' | 'https' {
    return this.tls === undefined ? 'http' : 'https'
  }

  /** Listen, adding the TLS frontend when material is configured. */
  override async [Service.init](): Promise<void> {
    await super[Service.init]()
    const { tlsCertPath, tlsKeyPath } = this.gate
    if (tlsCertPath === undefined || tlsKeyPath === undefined) return
    const routed = assertServer((this as unknown as { server: unknown }).server)
    const [cert, key] = await Promise.all([readFile(tlsCertPath), readFile(tlsKeyPath)])
    const tls = createTlsServer({ cert, key })
    // The decrypted TLSSocket keeps the underlying connection's remoteAddress,
    // so admission still reads the real peer rather than this process.
    tls.on('secureConnection', socket => { routed.emit('connection', socket) })
    tls.on('error', error => { this.ctx.logger.warn(error) })
    await new Promise<void>((resolve, reject) => {
      tls.once('error', reject)
      tls.listen(this.gate.port, this.gate.host, () => {
        tls.off('error', reject)
        this.tlsPort = (tls.address() as AddressInfo).port
        this.tls = tls
        resolve()
      })
    })
    this.ctx.effect(() => async () => {
      await new Promise<void>((resolve) => { tls.close(() => { resolve() }) })
      this.tls = undefined
      this.tlsPort = undefined
    }, 'lanyard: TLS listener')
  }

  /** Whether a request may reach the handler registered for one route path. */
  private permits(req: IncomingMessage, routePath: string): boolean {
    if ((this.gate.publicPaths ?? DEFAULT_PUBLIC_PATHS).includes(routePath)) return true
    if (!admit(req, this.gate.pairingToken)) return false
    /* v8 ignore next -- node always sets url on server requests */
    const endpoint = endpointOf(new URL(req.url ?? '/', 'http://x').pathname)
    if (endpoint === undefined) return true
    // Pairing authenticates a device; the configuration plane additionally
    // requires being at the machine, so it never travels to a paired device.
    return !isPrivilegedEndpoint(endpoint) || isLoopbackAddress(req.socket.remoteAddress)
  }

  /**
   * Register a named route behind admission.
   * @param route - kind, path, and the owning handler.
   * @returns the disposer removing the route.
   */
  override register(route: WebRoute): () => void {
    const inner = route.handler
    return super.register({
      ...route,
      handler: async (req, res) => {
        if (!this.permits(req, route.path)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        await inner(req, res)
      },
    })
  }

  /**
   * Register an upgrade route behind the same admission; a refused handshake is
   * rejected before protocol negotiation, so no event stream ever starts.
   * @param route - pathname and handler owning negotiation plus socket use.
   * @returns the disposer removing the route.
   */
  override registerUpgrade(route: WebUpgradeRoute): () => void {
    const inner = route.handler
    return super.registerUpgrade({
      ...route,
      handler: (req, socket, head) => {
        if (!this.permits(req, route.path)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        return inner(req, socket, head)
      },
    })
  }
}

export default GatedWebServer
