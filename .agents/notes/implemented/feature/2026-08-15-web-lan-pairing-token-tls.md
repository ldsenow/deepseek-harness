# Agent Note: LAN serving pairs a token with self-signed TLS

Status: implemented

English | [中文](2026-08-15-web-lan-pairing-token-tls.zh.md)

## Problem

The web GUI's `/api` surface executes code as the host process, so `dsh --profile web` refused `--host 0.0.0.0` outright: the [browser-trust fence](../architecture/2026-07-28-api-browser-trust-boundary.md) is a confused-deputy defense, not authentication, and an unauthenticated LAN bind hands remote code execution to the network. That refusal also blocked the legitimate deployment it was protecting: using the GUI from another device on the owner's own network (a phone browser, a PWA install, a WebView wrapper app) by typing the PC's `ip:port`.

## Decision

Authentication is a deployment-configured **pairing token**, enforced where the fence already lives (`dsh-client-connection`, `src/api-auth.ts`), and LAN serving wraps it in **self-signed TLS** owned by the web bundle:

- **Admission**: every request passes the Host fence (`src/api-request-trust.ts`) as the DNS-rebinding and cross-site defense. Beyond it, `admitApiRequest` (`src/api-auth.ts`) requires the pairing token from every non-loopback socket peer, presented as the `dsh_auth` cookie or `Authorization: Bearer` and compared constant-time over sha256 digests. Dedicated `trusted-host` RPC channels ride the same admission.
- **Loopback is the socket peer, never the `Host` header**: only a genuine loopback peer (`req.socket.remoteAddress`, `isLoopbackAddress`) skips the token, so a local process and forwarding tunnels (`adb reverse`, SSH) stay tokenless. On an all-interfaces bind any client reaching the socket can claim `Host: localhost`, so a header-based exemption would be a token bypass. The node layer passes the socket-derived fact to the Fetch handlers as a typed `RequestPeer` argument beside the request, so no header carries trust and no handler can read one.
- **The privileged method set and `loopback`-authority channels** stay pinned to a loopback peer even for authenticated callers: pairing authenticates a device, the configuration plane additionally requires being at the machine.
- **Pairing**: the printed LAN line is a pairing URL, `https://<lan-ip>:<port>/#auth=<token>` (Jupyter's pattern). The browser half (`src/client/auth.ts`) adopts the fragment into localStorage, strips it from the address bar, and republishes it each boot as a `SameSite=Strict` cookie, which the browser then attaches to fetches and WebSocket upgrades alike — no carrier plumbing, and the fragment never reaches a server or its logs.
- **The token reaches the CLI by reference**: `--pairing-token-env <name>` reads it from the named environment variable, following the `dsh-credentials` doctrine that configuration carries references to secrets rather than the secrets. The literal `--pairing-token <token>` remains for convenience, but a process's arguments are readable by every local user, so the help text and docs lead with the variable.
- **Fail-loud composition**: a token not matching `[A-Za-z0-9_-]{16,}` and a non-empty `trustedHosts` without a token both fail the plugin load; naming both token forms, naming a variable that holds nothing, and `--host 0.0.0.0` or `--trusted-host` without a token are usage errors at the CLI.
- **TLS**: `dsh-host-webserver` gains `tlsCertPath`/`tlsKeyPath` (paths, never inline material, so config-echoing surfaces cannot leak the key) and serves `node:https` when both are set. The `dsh-web-app/tls` provider generates a persistent self-signed pair under `dshHomePath('web-tls')` on the first all-interfaces boot — SAN carries loopback plus sampled LAN addresses, ten-year validity, owner-only key file — so a device's accept-once exception survives restarts. Loopback binds keep plain HTTP.

## Alternatives considered

- **Token without TLS.** Rejected: on shared Wi-Fi the token cookie and all session content would travel in cleartext; an authenticated-but-sniffable channel is not the "secure channel" the deployment asked for. The cost is the phone's one-time self-signed-certificate warning, absorbed into the same pairing-link visit.
- **Cookie-only or header-only presentation.** Rejected: browsers cannot set headers on WebSocket upgrades (cookie needed), and non-browser clients should not have to speak cookies (Bearer needed). Both feed one verifier.
- **Serving the token to the browser via the boot manifest.** Rejected outright: the SPA and its injected boot manifest are served unauthenticated, so anything in them is public to the network by definition. The fragment link keeps the secret out of every served byte.
- **Unlocking the privileged/configuration plane for authenticated devices.** Deferred, not decided: the pin's rationale (settings, credentials, native desktop actions) is about local presence, and loosening it deserves its own decision.
- **Dual-protocol sniffing so typed `http://ip:port` redirects.** Rejected for v1: peeking the first byte of every socket to multiplex HTTP and TLS on one port is real carrier complexity for a first-visit-only papercut the pairing link already avoids.

## Consequences

- `dsh --profile web --host 0.0.0.0 --pairing-token-env <name>` is the supported LAN deployment; the previous hard refusal is gone, and the trust-boundary note's deferred-authentication item is discharged here.
- A `trustedHosts` composition that predates this decision no longer admits anyone until it adds `pairingToken` — enforced at load, not discovered as silent 403s.
- A device that opens the bare authority without ever visiting a pairing link has no token-entry surface yet; it sees the ordinary reconnecting state (recorded as deferred client UI work in the connection README).
- The LAN IPs baked into an existing certificate's SAN drift as networks change; serving keeps working and only the browser warning re-appears, because admission never depends on the certificate.
