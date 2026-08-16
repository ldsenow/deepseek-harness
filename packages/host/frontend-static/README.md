# `@deepseek-ai/dsh-host-frontend-static`

English | [中文](README.zh.md)

SPA dist server for the Web shell: a function plugin (config `{distIndex}`) that claims the [webserver](../webserver/README.md)'s single fallback seat and serves the built frontend directory with the shell's locked semantics — traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), unknown extensions ship as `application/octet-stream`, and non-GET/HEAD without a matching named route is 405. Containment is checked twice: lexically on the joined path, then against the real path the filesystem resolves, so a symlink inside the dist pointing outside it is 403 rather than an arbitrary read — a network bind serves this seat to everyone, with no token in front of it. Links that stay inside the dist serve normally. `distIndex` is resolved through its links once at load, which also makes a missing dist fail the load instead of the first request.

## The document's security headers

This package is where the browser's origin policy is set, because it is the package that serves the document. Every index response mints a fresh script nonce, passes it to `applyIndexTaps` so the taps can stamp the scripts they inject, and sends a Content-Security-Policy naming that nonce; every static response also carries `X-Content-Type-Options: nosniff`, and documents carry `Referrer-Policy: no-referrer`.

The policy matters more here than in an ordinary app. The page holds the pairing token, and on the host machine it is itself a loopback peer, so script executing in this origin reaches the configuration plane a paired remote device is refused. The harness also serves third-party client plugin bundles into this origin by design, so "only our own code runs here" is something the policy states rather than assumes. `script-src` is `'self'` plus the per-response nonce, which admits the dist bundles and the injected boot scripts and nothing else; it also carries `'unsafe-eval'`, deliberately, because the client code runner evaluates model-authored code with `new Function` and that capability is the product. `style-src` permits inline because shiki and KaTeX emit `style` attributes no nonce can cover, `img-src` permits remote http(s) for markdown images plus `data:`/`blob:` for client-materialized attachments, and `connect-src 'self'` keeps fetches and the WebSocket downlinks on this origin. `object-src`, `base-uri`, `frame-ancestors`, and `form-action` are all closed. Every index response runs through the webserver's registered index taps (`applyIndexTaps`), which is how the boot manifest reaches the page. `distIndex` is an assembly fact of the composing application: [`dsh-web-app`](../../bundle/web-app/README.md) resolves it through the frontend package's exports and mounts this plugin; a deployment never hardcodes it.

The fallback seat is single-owner (a second claim throws) and effect-scoped: disposing the plugin's fiber releases the seat, after which the unclaimed webserver answers 404.

## Model Experience

None, as the package serves browser assets; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The starter MIME table is minimal** — it covers the Vite-emitted asset set plus the shipped PWA manifest; other extensions fall back to `application/octet-stream` until an asset class actually ships.
