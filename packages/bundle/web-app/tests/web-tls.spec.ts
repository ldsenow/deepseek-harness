/** TLS-material provider: generation, persistence across boots, and the loopback no-op. */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
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
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, 'not a directory')
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true, dir: join(file, 'nested') }))
    await expect(fiber).rejects.toThrow()
  })
})
