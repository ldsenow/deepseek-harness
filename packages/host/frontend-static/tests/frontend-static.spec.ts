/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, MIME fallback,
 * SPA index fallback with index taps, traversal rejection, 405 on non-GET/
 * HEAD, and seat release on fiber disposal (HMR safety).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a dist fixture and a two-row cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET one path and hand back the whole Response, for header assertions. */
async function requestFull(port: number, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}${path}`)
}

/** GET (by default) one path against the running server; returns status, content-type, and a body prefix. */
async function request(port: number, path: string, init?: RequestInit): Promise<{ status: number; type: string | null; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: (await response.text()).slice(0, 80),
  }
}

describe('real Loader composition', () => {
  it('serves the dist with SPA fallback, taps, traversal rejection, and method gating', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // `/`, the index path, and any miss all render index.html (SPA routing)
    // through the registered index taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    for (const path of ['/', '/index.html', '/no/such/route']) {
      const got = await request(port, path)
      expect(got.status).toBe(200)
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
    }
    untap()
    expect((await request(port, '/')).body).not.toContain('__T__')

    // Every document carries the policy, and the nonce in the header is the one
    // the taps stamped — a mismatch would leave the injected boot scripts
    // blocked and the shell without its manifest.
    const document_ = await requestFull(port, '/')
    const policy = document_.headers.get('content-security-policy')
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(document_.headers.get('x-content-type-options')).toBe('nosniff')
    const headerNonce = /'nonce-([^']+)'/.exec(policy ?? '')?.[1]
    expect(headerNonce).toBeDefined()
    const tapped = server.tapIndex((html, nonce) => html.replace('<head>', `<head><script nonce="${nonce}">1</script>`))
    const withScript = await requestFull(port, '/')
    const served = await withScript.text()
    const servedNonce = /'nonce-([^']+)'/.exec(withScript.headers.get('content-security-policy') ?? '')?.[1]
    expect(served).toContain(`<script nonce="${String(servedNonce)}">`)
    // A fresh nonce per response: one leaked from an earlier page must not keep
    // working on the next.
    expect(servedNonce).not.toBe(headerNonce)
    tapped()
    // Assets are not documents, but they still must not be content-sniffed.
    expect((await requestFull(port, '/app.js')).headers.get('x-content-type-options')).toBe('nosniff')

    // Traversal outside the dist root is 403; non-GET/HEAD is 405.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/nowhere', { method: 'POST' })).status).toBe(405)

    // A symlink inside the dist escapes every lexical check — the path stays
    // under the root and only the filesystem knows it leads elsewhere. On a
    // network bind that would be an arbitrary read of anything this process
    // can open, so containment is re-checked against the real path.
    const outside = join(root!, 'outside-secret.txt')
    await writeFile(outside, 'SECRET')
    await symlink(outside, join(root!, 'dist', 'leak.txt'))
    await symlink(root!, join(root!, 'dist', 'escape'))
    const leaked = await request(port, '/leak.txt')
    expect(leaked.status).toBe(403)
    expect(leaked.body).not.toContain('SECRET')
    expect((await request(port, '/escape/outside-secret.txt')).status).toBe(403)

    // A link that stays inside the dist is ordinary content, not an escape.
    await symlink(join(root!, 'dist', 'blob.bin'), join(root!, 'dist', 'alias.bin'))
    const aliased = await request(port, '/alias.bin')
    expect(aliased.status).toBe(200)
    expect(aliased.body).toBe('BLOB')

    // A real directory resolves and then fails to read: still SPA routing, not
    // a 500 and not a listing.
    await mkdir(join(root!, 'dist', 'assets'))
    const directory = await request(port, '/assets')
    expect(directory.status).toBe(200)
    expect(directory.body).toContain('shell')

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })
})
