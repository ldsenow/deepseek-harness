# Handover — lanyard plugin + `feat/web-lan-remote-access`

Written 2026-08-19. Everything below is pushed; nothing lives only in a container.

## TL;DR

Two parallel deliverables exist for the same capability — **secure LAN access to the `dsh` web GUI**:

| | Where | State |
|---|---|---|
| **A. Fork** (invasive) | `ldsenow/deepseek-harness` branch `feat/web-lan-remote-access` | Complete, reviewed, merged with master, all gates green |
| **B. Plugin** (no harness changes) | `ldsenow/deepseek-harness` **orphan** branch `lanyard` | Core proven and tested; needs finishing + relocation |

The pivot to **B** happened because upstream `deepseek-ai/deepseek-harness` does not accept PRs. **B is the intended direction.** A is kept as the reference implementation and as proof the design works.

## Immediate next step

The plugin must move to **`KoalaFacts/deepseek-harness-lanyard`** (already created, public, empty).

This session could not push there: the git proxy authorizes only `ldsenow/*`, and `add_repo` refuses cross-owner adds once a session has `ldsenow` sources. So the code was parked on an **orphan branch** (`lanyard`) — it shares no history with the harness and contains **zero harness source**.

To relocate, either:

```sh
# from anywhere with push rights to KoalaFacts
git clone --branch lanyard --single-branch \
  https://github.com/ldsenow/deepseek-harness.git lanyard && cd lanyard
git remote set-url origin https://github.com/KoalaFacts/deepseek-harness-lanyard.git
git push -u origin lanyard:main
```

…or **start a new Claude session with `KoalaFacts/deepseek-harness-lanyard` as its source** and point it at this file.

## B. The plugin (`lanyard`)

npm name `@koalafacts/lanyard`. Installs via `dsh plugin --profile web add @koalafacts/lanyard`.

### The core insight — why no harness change is needed

Every consumer registers its routes through `ctx.webServer.register` / `registerUpgrade`. So a **`WebServer` subclass** that overrides those two methods puts admission in front of everything the composition serves. `dsh-client-connection` — which owns `/api` and does its trust check inline — runs **completely unmodified**.

The bundle patch (`cordis.patch.yml`) disables the stock `webserver` row and inserts the gated one in its place.

### Two mechanisms, both proven by running code (not by reading it)

1. **Subclass gating works.** A spike registered a route exactly as `client-connection` does; anonymous → `403`, token → reached the handler.
2. **TLS preserves the peer address.** TLS is terminated in the subclass and the decrypted socket handed to the inherited `http` server via `emit('connection', socket)`. A spike confirmed `req.socket.remoteAddress` survives as the real client IP.

   ⚠️ **This is load-bearing.** A TCP-forwarding proxy would make every request read as a loopback peer and *silently disable the entire token gate*. Do not "simplify" this into a proxy.

### Files (orphan branch `lanyard`, repo root)

```
package.json         @koalafacts/lanyard + dsh.bundle.patch manifest
cordis.patch.yml     disables `webserver`, inserts lanyard-tls + lanyard-webserver
src/admission.ts     token compare, cookie parsing, loopback classification
src/webserver.ts     GatedWebServer: admission + privileged pin + TLS
src/tls.ts           self-signed cert provider (persistent, SAN carries LAN IPs)
tests/admission.spec.ts       22 tests — adversarial cases
tests/gated-webserver.spec.ts  5 tests — real HTTPS listener + fail-loud config
README.md            install, design, known limitations
```

**27 tests pass.**

### Running the tests

The plugin is not a workspace member, so deps were symlinked to the harness checkout:

```sh
# from a clone that sits beside a deepseek-harness checkout
H=/path/to/deepseek-harness
mkdir -p node_modules/@deepseek-ai
for e in "$H"/node_modules/*; do ln -sfn "$e" "node_modules/$(basename "$e")"; done
ln -sfn "$H/packages/host/webserver"          node_modules/@deepseek-ai/dsh-host-webserver
ln -sfn "$H/packages/client/connection"       node_modules/@deepseek-ai/dsh-client-connection
ln -sfn "$H/packages/credentials/credentials" node_modules/@deepseek-ai/dsh-credentials
ln -sfn "$H/vendor/cordis"                    node_modules/@deepseek-ai/cordis
ln -sfn "$H/vendor/schemastery"               node_modules/@deepseek-ai/schemastery
ln -sfn "$H/$(cd $H && ls -d node_modules/.pnpm/selfsigned@*/node_modules/selfsigned)" node_modules/selfsigned

"$H/node_modules/.bin/vitest" run --coverage=false --root "$PWD"
```

Once in its own repo this should become a normal `pnpm install` against published `@deepseek-ai/dsh-*` versions (`^0.1.0-rc.7`).

### Still to do on the plugin

1. **CLI flags** — `--host 0.0.0.0`, `--pairing-token-env`, `--keep-awake`. Upstream `web-app/src/startup.ts` **hard-refuses `0.0.0.0`** (`program.error`), so the patch must disable the `web-startup` row and insert a replacement providing `webStartup`. **Until this lands the plugin cannot actually be exercised end-to-end** — this is the top priority.
2. **Browser half** — adopt `#auth=<token>` into `localStorage`, strip the fragment, republish as a `SameSite=Strict` cookie each boot. Port from fork: `packages/client/connection/src/client/auth.ts`.
3. **Pairing URL printing** — `https://<lan-ip>:<port>/#auth=<token>` on the readiness line.
4. **Credential reference** — resolve `pairingTokenEnv` through `ctx.credentials` rather than taking a literal token (fork: `src/api-auth.ts::resolvePairingToken`).
5. **`--keep-awake`** — deliberately deferred; fully independent, port `packages/bundle/web-app/src/keep-awake.ts` verbatim (it only needs `ctx.subprocess`).
6. **Build** — no build config yet; needs `tsdown`/`tsc` emitting `lib/` to match the `exports` map.
7. **Real end-to-end run** — never yet booted inside an actual `dsh` install. Highest-value validation remaining.

### Known coupling (documented in README)

`GatedWebServer` subclasses `@deepseek-ai/dsh-host-webserver`, and TLS additionally reaches the inherited `node:http` server. TypeScript `private` is erased at runtime so this works, but a rename upstream would break it — `assertServer()` converts that into a **loud load failure** instead of silently serving plaintext. Verify this on every harness upgrade.

## A. The fork branch (`feat/web-lan-remote-access`)

25 commits ahead of `master`, master fully merged (0 behind), tree clean.

Gates: `build` ✅ · `doc-sync` ✅ 28/28 · `typecheck` ✅ 0 errors · `constraints` ✅ · 13,562 tests pass.

**18 product-code files, 812 insertions.** Everything else in the 100-file diff is tests (15), the mandatory bilingual doc triplets (43 files for 15 docs), build registration (14), and scaffolding.

### Do not be alarmed by 11 failing tests

They are **environmental and pre-existing** — byte-identically failing before and after the merge, in 10 packages this branch never touches. Proven, not assumed:

- This container runs as **root (uid 0)**, where `chmod 000` files and directories remain readable. Eight tests exist specifically to assert `EACCES`, so they cannot pass here.
- Running the same code as the non-root `ubuntu` user: **9 of 10 files pass** (429 tests).
- The 10th binds `::1`; this container returns `EAFNOSUPPORT` — no IPv6 at all.
- CI runs `ubuntu-latest` with no `container:` directive, i.e. non-root, so they pass there.

### Security fix worth carrying forward

Adversarial review found an **entire privileged namespace LAN-reachable**: `PRIVILEGED_METHODS` named one slash-form endpoint, but the Typert Gateway claims *every* `namespace/method` a live service exposes and registers as `trusted-host`. `dynamicCordisRunner` (12 methods — cross-session inventory, host-code execution, approval resolution) was reachable by any paired device.

Fixed by **inverting the default**: Gateway endpoints are classified *per namespace*, and an unclassified namespace is loopback-only. A gate (`verify-gateway-endpoint-authority`) fails the build until a new namespace is classified deliberately.

**The plugin carries this same design** (`PAIRED_NAMESPACES` allowlist in `src/webserver.ts`) — keep it that way.

## Open findings — reported, deliberately NOT fixed

Out of scope per explicit instruction; none blocks the feature. All verified.

1. **`/plugins/*.map` is served with no admission**, with `sourcemap: true` — any LAN peer gets full client source. *The plugin can actually fix this*, since its gate sits in `webServer.register`; consider removing `/plugins` from `publicPaths` for `.map` only.
2. **The keep-awake bound is partly theatre.** `RELEASE_TIMEOUT_MS` is 7 s but the CLI force-exits at 5 s, and `subprocess-local/src/index.ts:88` awaits `waitForExit()` **unbounded** in a sibling disposer that cordis runs concurrently. The real bound belongs in the subprocess seam. Comments were corrected to stop overclaiming; behaviour unchanged.
3. **`host.listDirectory` / `host.createDirectory` are unpinned** while `host.openPath` / `pickDirectory` are — arbitrary host enumeration and `mkdir` from a paired device.
4. **`/api/respond` is unpinned** — a paired device can answer approval prompts.
5. **The fail-loud CLI check keys on `--host`, not the effective bind** — a `--patch` setting `webserver.host: 0.0.0.0` bypasses it.

Items 1, 3, 4 are upstream bugs worth filing as issues regardless of PR policy.

## Conventions that bit me

- **Commits must be signed.** `commit.gpgsign=true`, `gpg.format=ssh`. Local `%G?` shows `N` and errors about `allowedSignersFile` — that is *verification* config missing, not a signing failure. Check for a real `gpgsig` header instead.
- **No `Co-Authored-By: Claude` trailers.** Standing user instruction.
- **Date-stamped Agent Notes are frozen.** Write a new note referencing the old one; do not edit the old one's decision or consequences.
- **Docs are bilingual triplets** — `.md` + `.zh.md` + `.i18n.yaml`. Re-record with
  `pnpm exec tsx scripts/verify-translation-pairing.ts --write <files>`.
- **Pushing the orphan branch needs `--no-verify`** — the harness pre-push hook runs `pnpm typecheck`, which does not exist in the plugin's `package.json`.

## Verifying a claim before trusting it

Several conclusions in this file were reached only after a first answer turned out wrong. If something here matters to a decision, re-derive it. Cheap, high-value checks used above:

- Mutation-test a guard: break the thing it guards, confirm the test fails. One "guard" test here passed against the mutation and guarded nothing.
- Prove environment claims mechanically (`chmod 000` as root vs non-root) rather than inferring from correlation.
- Diff full-suite failures before and after a merge instead of assuming the merge is at fault.
