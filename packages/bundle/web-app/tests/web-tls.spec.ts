/** TLS-material provider: generation, persistence across boots, and the loopback no-op. */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { X509Certificate } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, WEB_TLS_SERVICE, type WebTlsValues } from '../src/tls.ts'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  networkInterfaces: () => ({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }],
  }),
}))

let dir: string | undefined

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

async function mount(config: Config): Promise<{ values: WebTlsValues; dispose: () => Promise<void> }> {
  const ctx = new Context()
  ctx.provide('webStartup', {})
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { values: ctx.get(WEB_TLS_SERVICE) as WebTlsValues, dispose: () => fiber.dispose() }
}

describe('web-tls provider', () => {
  it('provides no paths and touches no files on a loopback deployment', async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'dsh-web-tls-')), 'material')
    const { values, dispose } = await mount(new Config({ enabled: false, dir }))
    expect(values).toEqual({})
    expect(existsSync(dir)).toBe(false)
    await dispose()
  })

  it('generates a self-signed pair once and reuses it across boots', async () => {
    dir = join(mkdtempSync(join(tmpdir(), 'dsh-web-tls-')), 'material')
    const { values, dispose } = await mount(new Config({ enabled: true, dir }))
    expect(values.paths).toEqual({ certPath: join(dir, 'cert.pem'), keyPath: join(dir, 'key.pem') })
    const { certPath, keyPath } = values.paths!
    const certificate = new X509Certificate(readFileSync(certPath))
    // The accept-once exception must cover the names a device dials: loopback
    // plus the LAN addresses sampled at generation.
    expect(certificate.subjectAltName).toContain('127.0.0.1')
    expect(certificate.subjectAltName).toContain('192.168.1.5')
    expect(certificate.subjectAltName).toContain('localhost')
    // Validity outlives a deployment: ten years, not the library default year.
    expect(new Date(certificate.validTo).getFullYear() - new Date(certificate.validFrom).getFullYear())
      .toBeGreaterThanOrEqual(9)
    // Key stays owner-only where the platform honors modes.
    if (process.platform !== 'win32') {
      expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    }
    await dispose()

    // Second boot: same material, no regeneration (the phone's accepted
    // exception must keep matching).
    const firstCert = readFileSync(certPath, 'utf8')
    const again = await mount(new Config({ enabled: true, dir }))
    expect(again.values.paths).toEqual(values.paths)
    expect(readFileSync(certPath, 'utf8')).toBe(firstCert)
    await again.dispose()
  })

  it('fails the load when the material directory cannot be created', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-web-tls-'))
    const file = join(dir, 'occupied')
    rmSync(file, { force: true })
    const ctx = new Context()
    ctx.provide('webStartup', {})
    writeFileSync(file, 'not a directory')
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true, dir: join(file, 'nested') }))
    await expect(fiber).rejects.toThrow()
  })

  it('generates the material through a real Loader composition, gated on the invocation flag', async () => {
    // REAL-composition proof (packages/AGENTS.md): the row boots through the
    // vendored Loader with the same `enabled` expression the shipped bundle
    // patch uses, and the assertion is the durable output — PEM files on disk.
    dir = mkdtempSync(join(tmpdir(), 'dsh-web-tls-loader-'))
    const material = join(dir, 'material')
    writeFileSync(join(dir, 'startup.mjs'), [
      "export const name = 'web-startup'",
      'export function apply(ctx) { ctx.provide("webStartup", { trustedHosts: [], host: "0.0.0.0" }) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'tls.mjs'), [
      "export const name = 'web-tls'",
      "export const inject = ['webStartup']",
      'export const apply = (ctx, config) => globalThis.__webTlsApply(ctx, config)',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: web-tls',
      `  name: ${pathToFileURL(join(dir, 'tls.mjs')).href}`,
      '  inject: [webStartup]',
      '  config:',
      "    enabled: !!js (ctx.webStartup.host ?? '127.0.0.1') === '0.0.0.0'",
      `    dir: ${JSON.stringify(material)}`,
      '- id: startup',
      `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
      '',
    ].join('\n'))
    ;(globalThis as unknown as { __webTlsApply: typeof apply }).__webTlsApply = apply

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const values = ctx.get(WEB_TLS_SERVICE) as WebTlsValues
    expect(values.paths).toEqual({ certPath: join(material, 'cert.pem'), keyPath: join(material, 'key.pem') })
    expect(existsSync(values.paths!.certPath)).toBe(true)
    expect(new X509Certificate(readFileSync(values.paths!.certPath)).subjectAltName).toContain('127.0.0.1')
    await ctx.fiber.dispose()
  })
})
