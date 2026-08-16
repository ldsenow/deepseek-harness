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
  const forbid = (): void => { res.writeHead(403); res.end() }
  const serveIndex = async (): Promise<void> => {
    // Fresh per document: a reused nonce keeps working for an injection that
    // once observed it.
    const nonce = randomBytes(16).toString('base64')
    const body = await renderIndex(nonce)
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': MIME['.html'],
      'content-security-policy': `${CSP_DIRECTIVES}; script-src 'self' 'unsafe-eval' 'nonce-${nonce}'`,
      'referrer-policy': 'no-referrer',
    })
    res.end(body)
  }
  // `sep`, not '/': resolve() emits backslashes on Windows, where a '/' suffix
  // would reject every legitimate subpath as traversal.
  if (!within(target, distRoot)) { forbid(); return }
  if (target === distRoot || target === distIndex) { await serveIndex(); return }
  try {
    // `resolve` normalizes `..` but does not follow links, so a symlink out of
    // the dist passes the check above. `distRoot` is link-free (see apply), so
    // both sides of the recheck are real paths.
    const resolved = await realpath(target)
    if (!within(resolved, distRoot)) { forbid(); return }
    const body = await readFile(resolved)
    // `target`, not `resolved`: a link's own name decides its type.
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    // Absent, a directory, or removed mid-read: SPA routing owns every miss.
    await serveIndex()
  }
}

/** Sent on every static response, documents and assets alike. */
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff' } as const

/**
 * The Content-Security-Policy every index response carries; what it defends
 * and why is in the package README. Three relaxations are load-bearing and
 * must not be tightened without replacing what depends on them: `'unsafe-eval'`
 * for the client code runner's `new Function`, inline `style-src` for the
 * `style` attributes shiki and KaTeX emit, and remote `img-src` for the images
 * markdown renders.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

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
  // Once, at load: a dist behind a symlinked parent (pnpm store, monorepo
  // link) would otherwise read as an escape on every request.
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
