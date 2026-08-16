/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with the semantics the
 * Web shell locked at step1 — traversal outside the dist root is 403, any
 * miss falls back to index.html with HTTP 200 (SPA routing), unknown
 * extensions ship as octet-stream, non-GET/HEAD is 405. Every index response
 * runs through the webserver's registered index taps (boot-manifest
 * injection). The dist location is workspace knowledge of the composing
 * application, so `distIndex` is typically supplied through a `!!js`
 * expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Service required before the fallback seat can be claimed. */
export const inject = ['webServer']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (index-tap injection) for
 * `/` and every SPA fallback, given the response's script nonce.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  renderIndex: (nonce: string) => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (!within(target, distRoot)) {
    res.writeHead(403)
    res.end()
    return
  }
  const serveIndex = async (): Promise<void> => {
    // One nonce per document: the taps stamp it on the scripts they inject, and
    // the policy admits exactly those. Reusing a nonce across responses would
    // let an injection that once observed it stay executable.
    const nonce = randomBytes(16).toString('base64')
    const body = await renderIndex(nonce)
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'content-security-policy': contentSecurityPolicy(nonce),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    })
    res.end(body)
  }
  if (target === distRoot || target === distIndex) {
    await serveIndex()
    return
  }
  let resolved: string
  try {
    // The check above is lexical, and path resolution does not follow links: a
    // symlink inside the dist root pointing outside it passes as an ordinary
    // subpath, and reading it would serve any file this process can open. Ask
    // the filesystem where the path really leads and re-check containment.
    // `distRoot` is itself already link-free (see apply), so the two sides of
    // the comparison are both real paths.
    resolved = await realpath(target)
  } catch {
    // The target does not exist; SPA routing owns every miss.
    await serveIndex()
    return
  }
  if (!within(resolved, distRoot)) {
    res.writeHead(403)
    res.end()
    return
  }
  try {
    const body = await readFile(resolved)
    // Extension of the request path, not of the link destination: what the
    // dist publishes under a name is what that name means to the client.
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  } catch {
    // Miss (EISDIR, or a file removed between realpath and read) falls back to
    // index.html with 200 (SPA routing).
    await serveIndex()
  }
}

/**
 * The Content-Security-Policy every index response carries. It is the last
 * line of defence for this origin, which matters more than usual on two
 * counts: the page holds the pairing token, and on the host machine it is
 * itself a loopback peer, so script running here reaches the configuration
 * plane a paired remote device is denied. The harness also serves third-party
 * client plugin bundles into this origin by design, so "only our own code
 * runs here" is a property the policy has to state rather than assume.
 *
 * Each directive earns its value:
 * - `script-src 'self' 'nonce-…'` admits the dist bundles and the two scripts
 *   the index taps inject, and nothing else — an injected `<script>` or event
 *   handler cannot execute. `'unsafe-eval'` is required, not incidental: the
 *   client code runner evaluates model-authored code with `new Function`, and
 *   that capability is the product, so the policy admits it and relies on the
 *   nonce to keep attacker markup from reaching it.
 * - `style-src` allows inline: shiki and KaTeX emit `style` attributes, which
 *   no nonce can cover.
 * - `img-src` allows remote http(s) because markdown renders remote images,
 *   plus `data:`/`blob:` for attachments the client materializes itself.
 * - `connect-src 'self'` keeps fetches and the WebSocket downlinks on this
 *   origin, which is what closes the exfiltration path images leave open.
 * - `object-src`, `base-uri`, `frame-ancestors`, and `form-action` are shut:
 *   this page embeds no plugins, rebases no URLs, is framed by nobody, and
 *   submits no forms.
 * @param nonce - this response's script nonce.
 * @returns the policy header value.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ')
}

/**
 * Whether one absolute path is the root itself or sits beneath it.
 * @param candidate - absolute path to test.
 * @param root - absolute directory the candidate must not escape.
 * @returns true when the candidate is contained by the root.
 */
function within(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Resolve links once, at load: every later containment check compares real
  // paths against a real root, so a dist reached through a symlinked parent
  // (a pnpm store, a monorepo link) is not mistaken for an escape. A missing
  // dist fails the load here instead of answering the first request.
  const distIndex = realpathSync(config.distIndex)
  const distRoot = dirname(distIndex)
  const renderIndex = async (nonce: string): Promise<string> =>
    ctx.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'), nonce)
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, renderIndex)
  }), 'frontend-static: fallback seat')
}
