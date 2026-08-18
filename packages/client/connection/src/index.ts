/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority } from './api-request-trust.ts'
import { admitApiRequest, resolvePairingToken } from './api-auth.ts'
import { isLoopbackAddress } from '@deepseek-ai/dsh-loopback'
import { isLoopbackOnlyNamespace } from './gateway-authority.ts'
import { HostConnectionService } from './rpc-host.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

export { PAIRING_TOKEN_PATTERN, PAIRING_TOKEN_REQUIREMENT } from './auth-wire.ts'
export { resolvePairingToken } from './api-auth.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /**
   * Credential reference — an environment-variable-shaped name — holding the
   * pairing token every /api request from a non-loopback socket peer must
   * present, as the `dsh_auth` cookie the browser client sets after opening a
   * `#auth=<token>` pairing link or an `Authorization: Bearer` header. The
   * reference resolves through `ctx.credentials`, so the value may come from
   * the environment, the managed credential store, or a `.env` layer;
   * configuration never carries the token itself. A reference that resolves to
   * nothing, or to a token that is not at least 16 characters of
   * `A-Za-z0-9_-`, fails the load, as does naming one without a composed
   * credentials service — so a composition that sets this must also inject
   * `credentials` on this row, guaranteeing the seam is active before this
   * plugin loads. Required together with a non-empty `trustedHosts`: a declared
   * authority without a token could admit no request. A loopback peer never
   * needs it.
   */
  pairingTokenEnv?: string
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  pairingTokenEnv: z.string(),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Endpoints gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. `trustedHosts` is a
 * DNS-rebinding fence, not authentication, and the pairing token authenticates
 * a device rather than a location, so the configuration plane stays pinned to a
 * loopback socket peer even for an authenticated caller; loosening that is an
 * open decision, not an omission. `llm.discoverModels` belongs to that plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 *
 * This set names the API Proxy's dot-form methods only. The Typert Gateway's
 * `namespace/method` form is classified per namespace in
 * [gateway-authority](./gateway-authority.ts); {@link isPrivilegedEndpoint}
 * applies both, once, ahead of the choice between the two handlers.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/**
 * Whether an endpoint stays pinned to a loopback peer. Dot-form API Proxy
 * methods are named individually; the Gateway's slash form is decided by its
 * namespace ([gateway-authority](./gateway-authority.ts)), because that
 * endpoint space grows with every `./typert` export and a per-method list
 * would default each new one to LAN-reachable.
 * @param endpoint - the endpoint identity, either `method` or `namespace/method`.
 * @returns true when only a loopback socket peer may reach it.
 */
function isPrivilegedEndpoint(endpoint: string): boolean {
  if (PRIVILEGED_METHODS.has(endpoint)) return true
  const separator = endpoint.indexOf('/')
  return separator !== -1 && isLoopbackOnlyNamespace(endpoint.slice(0, separator))
}

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence and, beyond loopback, pairing-token
 * authentication (DNS-rebinding and cross-site defense —
 * [api-request-trust](./api-request-trust.ts); token admission —
 * [api-auth](./api-auth.ts)); privileged methods additionally require a
 * loopback socket peer, which pins them to the local machine.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config?: ConnectionConfig): Promise<void> {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (trustedHosts.length > 0 && config?.pairingTokenEnv === undefined) {
    throw new Error('client-connection: trustedHosts requires pairingTokenEnv — without a pairing token no non-loopback request is admitted')
  }
  const pairingToken = await resolvePairingToken(ctx, config?.pairingTokenEnv)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts, pairingToken)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, isPrivilegedEndpoint, {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return toFetchHandler(apiProxy).fetch(request)
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      const peerIsLoopback = isLoopbackAddress(req.socket.remoteAddress)
      if (!admitApiRequest(req, trustedHosts, pairingToken, peerIsLoopback)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!admitApiRequest(req, trustedHosts, pairingToken, isLoopbackAddress(req.socket.remoteAddress))) {
            rejectWebSocketUpgrade(socket)
            return
          }
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
  })
}
