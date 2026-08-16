# dsh-loopback

English | [中文](README.zh.md)

Zero-dependency loopback classification: two pure predicates, no `ctx`, no state, no events. Browser-safe, so the same rules answer for a page's own location and for a Node socket.

## API

```ts
import { isLoopbackAddress, isLoopbackHostname } from '@deepseek-ai/dsh-loopback'
```

| Export | Role |
|---|---|
| `isLoopbackHostname(hostname)` | Whether a WHATWG URL hostname names the loopback authority: `localhost`, `[::1]`, or IPv4 `127.0.0.0/8`. |
| `isLoopbackAddress(address)` | Whether a socket peer address (`req.socket.remoteAddress`) is the loopback interface: IPv4 `127.0.0.0/8`, `::1`, or IPv4-mapped `::ffff:127.x.x.x`. `undefined` is not loopback. |

## The two are not interchangeable

A hostname is what a client **claims**; a socket peer address is what the kernel **observed**. On an all-interfaces bind any client that reaches the socket can send `Host: localhost`, so a route deciding whether its caller is local must read `isLoopbackAddress` — deriving that decision from a hostname is a forgeable exemption, which is how [the /api token bypass](../../../.agents/notes/implemented/feature/2026-08-15-web-lan-pairing-token-tls.md) happened. `isLoopbackHostname` answers a different question: which authority a URL names, for the DNS-rebinding fence and for a page describing its own location.

Both fail closed. An address the predicate does not recognize — an unusual literal form, a non-IP transport, `undefined` — is not loopback, so a caller keeps whatever authentication the route requires rather than being exempted by a parsing gap.

## Consumers

[`dsh-client-connection`](../../client/connection/README.md) uses both: the `/api` Host fence and the browser half's `ctx.connection.isLoopback` read hostnames, while token admission and the privileged-endpoint pin read the socket peer. [`dsh-client-hmr`](../../client/hmr/README.md) holds its `/plugins/events` reload channel to a loopback peer.

## Model Experience

None, as these predicates classify a network address for a route's admission decision and no result of theirs reaches a prompt, a tool schema, or a tool result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **IPv4 literals only in the dotted-quad form** — `127.1`, `2130706433`, and zero-padded octets classify as non-loopback. Node reports peer addresses in canonical form and browsers normalize URL hostnames, so no current consumer produces the other spellings; the bias is toward requiring authentication, never toward exempting.
- **No IPv6 zone-index handling** — a scoped `::1%lo0` is not recognized. Same direction of failure, and no observed peer address carries a zone.
