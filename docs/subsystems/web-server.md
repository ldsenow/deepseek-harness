# HTTP Server

English | [中文](web-server.zh.md)

[dsh-host-webserver](../../packages/host/webserver) is the browser HTTP carrier for the GUI host: a single `node:http`/`node:https` plugin providing `ctx.webServer`, a named-route registry, index.html transform callbacks, and one fallback handler that a plugin may claim. It is not part of the agent loop and not a capability seam; it knows no harness concepts, and another plugin registers every feature route, including the `/api` bridge, plugin bundles, and the HMR event stream ([layering note](../../.agents/notes/implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)). It serves browsers only: Electron loads the built files over `file://` and sends fetch requests through an IPC bridge instead of this server.

Source: [`packages/host/webserver/src/index.ts`](../../packages/host/webserver/src/index.ts)

## Routes

```ts type-equiv
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
type WebRouteKind = 'exact' | 'prefix'
```

```ts type-equiv
/** One named route registration. */
interface WebRoute {
  kind: WebRouteKind
  /** Absolute pathname, no trailing slash. */
  path: string
  /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
```

Match order is fixed: exact table first, then longest matching prefix, then the registered fallback. Registration order carries no request-facing semantics — named routes are composed to be disjoint, and the fallback seat answers anything no named route claims; one owner only, a second registration throws. The shipped Web composition claims the seat with [`dsh-host-frontend-static`](../../packages/host/frontend-static/src/index.ts), the SPA dist server with locked semantics: non-GET/HEAD is 405, traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), and unknown extensions ship as octet-stream.

## Config

```ts type-equiv
/** Gateway config: the listen address and optional TLS material. */
interface Config {
  /** Listen host; the two supported values are loopback and all-interfaces. */
  host: '127.0.0.1' | '0.0.0.0'
  /** Listen port; zero requests an OS-assigned port. */
  port: number
  /** PEM certificate file served to clients; set together with {@link tlsKeyPath} to serve HTTPS. */
  tlsCertPath?: string
  /** PEM private-key file for {@link tlsCertPath}; a path, never inline material, so config surfaces cannot carry the key. */
  tlsKeyPath?: string
}
```

`host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure). Configuring both TLS paths swaps `node:http` for `node:https` with identical route, upgrade, and teardown semantics — half a pair or unreadable material rejects activation — and the material's provenance belongs to the composing application ([dsh-web-app](../../packages/bundle/web-app/README.md) generates a persistent self-signed pair for LAN serving). There is no auth or origin policy in this package: admission for the `/api` family (the browser-trust fence and pairing token) is owned by the connection plugin, so a non-loopback bind exposes every route that lacks such an owner to that network. The dist location is an assembly fact of the frontend plugin that claims the seat.

## The service

`WebServer` (`ctx.webServer`) listens immediately on activation; a listen failure (EADDRINUSE…) rejects initialization, and the boot process reports the failed fiber. `register(route)` adds one named route and returns its disposer; a duplicate `(kind, path)` throws because route patterns are a composition-level contract and a collision is a misconfiguration. `tapIndex(transform)` adds a pure html-to-html transform applied to every index response — `/` and each SPA fallback — in registration order, receiving that response's script nonce; [dsh-client-modules](../../packages/client/modules) uses it to inject the boot manifest, carrying the nonce so the serving owner's Content-Security-Policy admits it. `port` reads the listening port, including the port assigned by the OS when `config.port` is 0; `scheme` reads `'https'` when TLS material is configured, else `'http'`.

A request whose handling throws (a malformed %-escape hitting `decodeURIComponent`, a client dropping mid-body) is logged as a warning and answered 400 — or the socket destroyed when headers are already out — never a process exit. Disposal pairs `close()` with `closeAllConnections()` because a handler may hold its response open (SSE) and such connections never end on their own; without the force-close, teardown would hang. The package never prints: the URL line belongs to the shell. Per-package operational detail, including the dev-mode bundle watch pipeline, stays in the [README](../../packages/host/webserver/README.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwebserver--webserver"></a>

### `ctx.webServer` — `WebServer`

The browser HTTP carrier service. Activation listens immediately. Route registration order does not affect requests because configured named routes must be distinct, and the fallback handler answers anything not yet claimed during startup with 404 until its owner registers. A listen failure rejects initialization, and the boot process reports the failed fiber.

```ts cordis-catalog
/**
 * Register a named route. Duplicate (kind, path) throws — route patterns are
 * a composition-level contract, so a collision is a misconfiguration.
 * @param route - kind, path, and the owning handler.
 * @returns the disposer removing the route.
 */
register(route: WebRoute): () => void

/**
 * Register an exact-path HTTP upgrade route. Duplicate paths throw because
 * one socket can have only one protocol owner.
 * @param route - pathname and handler owning negotiation plus socket use.
 * @returns the disposer removing the route.
 */
registerUpgrade(route: WebUpgradeRoute): () => void

/**
 * Claim the fallback seat: the handler answering every request no named
 * route matches (the SPA dist server in the shipped Web composition). One
 * owner only — a second registration throws, because two fallbacks cannot
 * compose.
 * @param handler - owns the full response lifecycle of unmatched requests.
 * @returns the disposer releasing the seat.
 */
registerFallback(handler: WebRoute['handler']): () => void

/**
 * Register an index.html transform, applied by the fallback owner to every
 * index response ({@link applyIndexTaps}) in registration order.
 * @param transform - pure html-to-html function; see {@link IndexTap} for the nonce obligation.
 * @returns the disposer removing the transform.
 */
tapIndex(transform: IndexTap): () => void

/**
 * Run an index.html body through the registered taps in registration order
 * — called by the fallback owner on every index response it renders.
 * @param html - the raw index.html body.
 * @param nonce - the response's script nonce, forwarded to every tap.
 * @returns the transformed body.
 */
applyIndexTaps(html: string, nonce: string): string
```

Source: [`packages/host/webserver/src/index.ts:74`](../../packages/host/webserver/src/index.ts)
<!-- END GENERATED cordis-surface -->
