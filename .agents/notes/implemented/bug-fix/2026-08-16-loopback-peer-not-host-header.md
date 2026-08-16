# Agent Note: loopback trust is the socket peer, not the Host header

Status: implemented

English | [中文](2026-08-16-loopback-peer-not-host-header.zh.md)

## Problem

The [LAN pairing feature](../feature/2026-08-15-web-lan-pairing-token-tls.md) granted the tokenless loopback exemption — and the privileged-method pin — from the request `Host` header (`isLoopbackHostname(hostUrl.hostname)`). That was safe while the server bound `127.0.0.1` only, because no non-browser client could reach the socket. Opening the bind to `0.0.0.0` made it a complete authentication bypass: the `Host` header is un-forgeable only by a *browser*, and any LAN device can now reach the socket with a raw client. A pre-release review confirmed it live — `curl` to the server's LAN IP with `-H 'Host: localhost'` and no token returned `200` for `/api` methods and for the loopback-pinned privileged plane (`settings.describe`, `credentials.describe`), i.e. unauthenticated RCE-grade access plus config/credential disclosure to any device on the network.

## Decision

Derive the loopback trust class from the socket peer address, never the `Host` header.

- `isLoopbackAddress(req.socket.remoteAddress)` (`src/loopback-hostname.ts`) decides loopback from the real connection origin the kernel reports (`127.0.0.0/8`, `::1`, IPv4-mapped `::ffff:127.x`); an absent address fails closed to token-required.
- `admitApiRequest` takes an explicit `peerIsLoopback` and grants the tokenless class only to a loopback peer; a non-loopback peer must present the token regardless of what `Host` it claims. The Host fence still runs for every request as the DNS-rebinding/cross-site defense — it just no longer authenticates.
- The privileged-method pin and `authority: 'loopback'` RPC channels require a loopback peer. Because those checks run on the Fetch representation (which has no socket), the node layer stamps the socket-derived fact onto an internal request header (`stampPeerLoopback` / `requestPeerIsLoopback`, `PEER_LOOPBACK_HEADER`), overwriting any client-supplied copy, so the Fetch-side pins read it unforgeably.
- Enforced at all four points: the `/api` route, both WebSocket upgrades, dedicated RPC channels, and the Fetch-side privileged/interceptor pins.

`adb reverse` and SSH tunnels are unaffected: they connect from `127.0.0.1` on the PC, so the server genuinely sees a loopback peer and stays tokenless — the documented tunnel workflow is preserved.

## Alternatives considered

- **Keep the Host-based exemption but require the token for `0.0.0.0` binds even on loopback Host.** Rejected: it conflates reachability with authentication and still trusts a client header for the privileged pin; the socket peer is the fact that actually distinguishes local from remote.
- **Drop the loopback exemption entirely (always require the token).** Rejected: it breaks tokenless local use and tunnels, which the feature deliberately preserves, for no security gain over a correct peer check.

## Consequences

- The `api-auth.host.spec.ts` case that encoded "loopback is decided from the Host header" is replaced by peer-based cases plus an explicit regression: a non-loopback peer forging `Host: 127.0.0.1`/`localhost`/`[::1]` is refused on both the HTTP route and the WebSocket upgrade.
- The real-HTTP node test now asserts the genuine-loopback-peer path (a real `127.0.0.1` connection is admitted tokenless, privileged plane included) and that the Host fence still refuses rebinding/cross-site from a loopback peer. Remote-peer denial is covered by the hand-built tests with an injected LAN `remoteAddress`, because a portable test cannot mint a real non-loopback peer.
- Also hardened alongside: the `dsh_auth` cookie gains `Secure` on https pages, and the `web-tls` material directory is created `0o700`.
