# lanyard

Secure LAN access for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI: a pairing token and self-signed TLS, shipped as an out-of-tree `dsh` plugin.

**No harness source changes.** `lanyard` installs into a profile as an ordinary bundle. It replaces one row — the HTTP carrier — with a subclass that gates what the stock carrier serves. Every other plugin, `dsh-client-connection` included, runs unmodified.

## Why this exists

`dsh web` binds `127.0.0.1` and refuses `--host 0.0.0.0`, for a good reason: the `/api` surface executes commands as the `dsh` process, so an unauthenticated LAN bind hands remote code execution to the network. That refusal also blocks the legitimate case it protects — using the GUI from your phone on your own network.

`lanyard` supplies the missing authentication layer so the bind becomes safe.

## Install

```sh
dsh plugin --profile web add @koalafacts/lanyard
```

Then run with a token and an all-interfaces bind:

```sh
export DSH_PAIRING_TOKEN="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
dsh web --host 0.0.0.0 --pairing-token-env DSH_PAIRING_TOKEN
```

Open the printed `https://<lan-ip>:<port>/#auth=<token>` link once on the other device. The page stores the token and strips it from the address bar; afterwards the bare authority reconnects.

## How it works

Every consumer registers its routes through `ctx.webServer.register` and `registerUpgrade`. `GatedWebServer` overrides both, so admission runs in front of every route the composition serves without any consumer knowing:

- **Admission** — a request from a non-loopback socket peer must present the token as the `dsh_auth` cookie or `Authorization: Bearer`, compared constant-time over sha256 digests.
- **Loopback is the socket peer, never the `Host` header.** On an all-interfaces bind any client reaching the socket can claim `Host: localhost`, so a header-derived exemption would be a complete bypass.
- **TLS is terminated here** and the decrypted socket is handed to the inherited HTTP server. That preserves `req.socket.remoteAddress` as the real client address — a TCP-forwarding proxy would make every request read as loopback and silently disable the gate.
- **The configuration plane stays pinned to a loopback peer** even for an authenticated caller: pairing authenticates a device, while settings, credentials, native dialogs, and the self-modification runtime additionally require being at the machine.
- **Unknown Gateway namespaces fail closed.** The Typert Gateway claims every `namespace/method` a live remote service exposes, so a per-method allowlist would default each new endpoint to reachable. Namespaces are classified whole, and anything unlisted is loopback-only.

## Known limitations

- **One shared secret, no revocation.** Rotating the token means changing the credential and restarting; there is no way to un-pair a single device.
- **The token is readable by page scripts.** It lives in `localStorage` and a non-`HttpOnly` cookie, necessarily, since the browser half sets it.
- **A forwarding tunnel counts as local.** `adb reverse` or `ssh -R` makes the device a loopback peer, which skips the token *and* reaches the configuration plane. Treat a tunnel as handing over the same authority you have at the keyboard.
- **Self-signed certificate.** Each device accepts it once. The SAN carries the LAN addresses sampled at generation, so a network change re-prompts the warning; serving still works, because admission never depends on the certificate.
- **Version-coupled to the carrier.** `GatedWebServer` subclasses `@deepseek-ai/dsh-host-webserver`. TLS additionally needs the inherited `node:http` server; if a future version stops exposing it, the plugin fails its load loudly rather than quietly serving plaintext.

## License

MIT
