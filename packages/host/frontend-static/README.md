# `@deepseek-ai/dsh-host-frontend-static`

English | [中文](README.zh.md)

SPA dist server for the Web shell: a function plugin (config `{distIndex}`) that claims the [webserver](../webserver/README.md)'s single fallback seat and serves the built frontend directory with the shell's locked semantics — traversal outside the dist root is 403, any miss falls back to `index.html` with HTTP 200 (SPA routing), unknown extensions ship as `application/octet-stream`, and non-GET/HEAD without a matching named route is 405. Containment is checked twice: lexically on the joined path, then against the real path the filesystem resolves, so a symlink inside the dist pointing outside it is 403 rather than an arbitrary read — a network bind serves this seat to everyone, with no token in front of it. Links that stay inside the dist serve normally. `distIndex` is resolved through its links once at load, which also makes a missing dist fail the load instead of the first request. Every index response runs through the webserver's registered index taps (`applyIndexTaps`), which is how the boot manifest reaches the page. `distIndex` is an assembly fact of the composing application: [`dsh-web-app`](../../bundle/web-app/README.md) resolves it through the frontend package's exports and mounts this plugin; a deployment never hardcodes it.

The fallback seat is single-owner (a second claim throws) and effect-scoped: disposing the plugin's fiber releases the seat, after which the unclaimed webserver answers 404.

## Model Experience

None, as the package serves browser assets; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The starter MIME table is minimal** — it covers the Vite-emitted asset set plus the shipped PWA manifest; other extensions fall back to `application/octet-stream` until an asset class actually ships.
