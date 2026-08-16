# `@deepseek-ai/dsh-web-app`

English | [中文](README.zh.md)

The dsh browser-surface bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-base`](../base/README.md): it sets the coding persona, inserts the Web host rows (webserver, API gateway, workspace, projection cache, storage) and the browser plugin roster, the always-on client-plugin reload chain ([`dsh-client-hmr`](../../client/hmr/README.md), idle until a rebuild watcher rewrites client bundles), and mounts this package's `web-runtime` glue plugin (config `{printUrl, surfaceContext, trustedHosts, pairingToken}`). That plugin resolves the built frontend dist through `@deepseek-ai/dsh-web-frontend`'s exports, samples bind-dependent LAN trust once, provides it with the pairing token as `webRuntime` to the browser-trust fence and client roster, mounts the [`frontend-static`](../../host/frontend-static/README.md) fallback owner, registers the harness-source and web-surface prompt sections plus the bash-visible `DSH_WEB_URL` runtime variable when `surfaceContext` is true, and prints the `dsh web:` URL line when `printUrl` is true, after its Loader tree settles so a sibling failure cannot announce a dead app. This bundle also owns the app command line: the ordinary `web-startup` provider ([`src/startup.ts`](src/startup.ts)) injects `ctx.cmdlineArgs` ([`dsh-cmdline`](../../boot/cmdline/README.md)), parses `--host`, `--port`, repeatable `--trusted-host`, `--pairing-token-env`, `--pairing-token`, `--keep-awake`, and the app's `--help`, then provides `webStartup`. Flag-configured rows inject the service and read it directly from lazy config, so nothing binds a port before argument resolution and `dsh --profile web --help` starts no server. [`dsh-headless`](../headless/README.md) is a sibling surface over the same base and does not mount this bundle.

## LAN serving: pairing token + TLS

`dsh --profile web --host 0.0.0.0 --pairing-token-env <name>` serves the GUI to the local network, taking the token from the named environment variable; `--pairing-token <token>` passes it directly, at the cost of every local user being able to read it from the process argument list. Naming both, naming a variable that holds nothing, and `--host 0.0.0.0` or `--trusted-host` without a token at all are each usage errors — the last because the [connection plugin](../../client/connection/README.md) admits no non-loopback caller without one. An all-interfaces bind also enables TLS: the `web-tls` provider ([`src/tls.ts`](src/tls.ts), config `{enabled, dir}`) generates a self-signed certificate once under `dshHomePath('web-tls')` (SAN: loopback plus the LAN addresses sampled at generation; ten-year validity; owner-only key) and hands the webserver row the PEM paths, so restarts keep the certificate a paired device already accepted. The printed LAN line is the pairing URL `https://<lan-ip>:<port>/#auth=<token>`, which a device opens once. A loopback bind provides no TLS paths and stays on plain HTTP.

`--keep-awake` holds the platform's sleep inhibitor for the process lifetime (`web-keep-awake`, [`src/keep-awake.ts`](src/keep-awake.ts), config `{enabled}`): `caffeinate -i` on macOS, `systemd-inhibit --what=sleep:idle --mode=block` on Linux, a PowerShell `SetThreadExecutionState` holder on Windows, each released when the child or the dsh process dies. Activation rejects when the inhibitor cannot start; one dying later logs a warning and serving continues. The child runs with the credential-scrubbed environment.

## Model Experience

### Harness-source and Web-surface context

#### What the model sees

When `surfaceContext` is true, the `harness:source` section identifies the on-disk Harness implementation without claiming it is the working directory, and the `app:web-surface` global section (order −98) orients the model to the GUI: the canonical local URL, the "this page" referent, the update contract (the reload receiver is always on; no-refresh reloads additionally need the `pnpm run dev:web` watcher), and the instruction not to start replacement servers. `DSH_WEB_URL` additionally appears in the managed bash environment with its description, resolved per invocation from the live server. When it is false, neither section nor the variable is registered.

#### Token effect

One source line and one prompt paragraph per session plus two managed-environment variable lines; constant per process.

#### KV Cache effect

The prompt section sits near the system prompt's head and is stable for the life of the process (the port is a boot fact), so it does not invalidate the cache across turns.

## Known Limitations and Deferred Work

- **The frontend dist must be built** — `require.resolve` of the dist fails loud at activation with a build hint; there is no source-serving fallback.
- **`lanAddresses` is a boot-time snapshot** — interface changes after boot are not re-advertised; the printed LAN URL always matches the configured trust fence, and a LAN address absent from an already-generated certificate's SAN only re-prompts the browser warning.
- **Typing the bare `ip:port` may dial `http://` first** — some browsers default typed authorities to plain HTTP, which the TLS port refuses; open the printed `https://` pairing link once and the browser autocompletes `https` thereafter. Dual-protocol sniffing on one port is deliberately not implemented.
- **`--keep-awake` inhibits idle sleep only** — closing a laptop lid still sleeps the machine on every platform (the lid action is OS policy the inhibitors do not override), and the display may still turn off. A dsh process ended without disposal (`SIGKILL`) orphans the inhibitor child, which holds the lock until it is killed or the machine restarts.
