# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI through the [root README](../../../README.md#run); the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a DeepSeek API key, and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Remote access (LAN)

By default the server binds `127.0.0.1`, reachable only from the host machine. To reach the Web UI from another device on your network, bind all interfaces and set a pairing token:

```sh
dsh web --host 0.0.0.0 --pairing-token "$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
```

The `/api` surface executes commands as the `dsh` process, so `--host 0.0.0.0` requires `--pairing-token` (at least 16 characters of `A-Za-z0-9_-`); starting without one is an error. On an all-interfaces bind the server also serves HTTPS with a self-signed certificate generated once and reused across restarts.

The startup line prints a pairing URL:

```
dsh web: https://127.0.0.1:3080 (LAN: https://192.168.1.5:3080/#auth=<token>)
```

Open the `LAN:` link once on the other device. Its browser shows a one-time certificate warning (the certificate is self-signed) — accept it; the page then stores the token from the URL fragment and strips it from the address bar. After that first visit you reconnect by typing the bare `https://<lan-ip>:3080`. A device that never opens the pairing link cannot authenticate and stays on the reconnecting screen.

Loopback use and forwarding tunnels stay tokenless: `adb reverse tcp:3080 tcp:3080` (USB or wireless debugging) or an SSH tunnel makes the phone reach the PC through `127.0.0.1`, which needs no token and no certificate acceptance.

Add `--keep-awake` to hold the operating system's sleep inhibitor while the server runs, so idle sleep does not cut off a session or a paired device; it inhibits idle sleep only — closing a laptop lid still sleeps the machine.

A paired remote device can create sessions and run the agent, but the configuration plane (settings, credentials, native dialogs) stays available only on the host machine itself. Traffic is authenticated and encrypted, but the certificate is self-signed — use it on networks you trust, or front it with a VPN such as Tailscale for access away from home.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
