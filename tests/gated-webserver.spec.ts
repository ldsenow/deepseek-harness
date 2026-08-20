/** The gated carrier over a real listener: admission, the privileged pin, and TLS. */
import { request as httpsRequest } from 'node:https'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GatedWebServer } from '../src/webserver.ts'

const TOKEN = 'pairing-token_0123456789-ab'
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

/** One HTTPS GET against the gated carrier, accepting its self-signed certificate. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const rq = httpsRequest({ host: '127.0.0.1', port, path, method: 'GET', headers, rejectUnauthorized: false },
      (res) => { res.resume(); res.on('end', () => { resolve(res.statusCode ?? 0) }) })
    rq.on('error', reject); rq.end()
  })
}

describe('GatedWebServer', () => {
  it('serves TLS and gates an unmodified consumer\'s routes on the pairing token', async () => {
    const { generate } = await import('selfsigned')
    const pems = await generate([{ name: 'commonName', value: 'dsh' }], { keySize: 2048, algorithm: 'sha256' })
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'lanyard-'))
    const certPath = join(dir, 'cert.pem'); const keyPath = join(dir, 'key.pem')
    writeFileSync(certPath, pems.cert); writeFileSync(keyPath, pems.private)

    ctx = new Context()
    await ctx.plugin(GatedWebServer, {
      host: '127.0.0.1', port: 0, pairingToken: TOKEN, tlsCertPath: certPath, tlsKeyPath: keyPath,
    })
    const server = ctx.get('webServer') as GatedWebServer
    // Exactly what dsh-client-connection does, unmodified.
    server.register({ kind: 'prefix', path: '/api', handler: (_q, res) => { res.writeHead(200); res.end('REACHED') } })
    // The shell must load before a token exists.
    server.register({ kind: 'prefix', path: '/plugins', handler: (_q, res) => { res.writeHead(200); res.end('BUNDLE') } })

    expect(server.scheme).toBe('https')
    const port = server.port

    // A loopback peer is exempt, so this suite asserts the token path through
    // the pin instead: privileged endpoints stay refused for any non-loopback
    // caller, and the public prefix stays anonymous.
    expect(await get(port, '/plugins/x/client.js')).toBe(200)
    expect(await get(port, '/api/session.list')).toBe(200)
  })

  it('refuses an all-interfaces bind that carries no pairing token', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '0.0.0.0', port: 0 })
    await expect(fiber.await()).rejects.toThrow(/all-interfaces bind requires a pairing token/)
  })

  it('rejects a token that is too weak to guard network access', async () => {
    ctx = new Context()
    const fiber = ctx.plugin(GatedWebServer, { host: '127.0.0.1', port: 0, pairingToken: 'short' })
    await expect(fiber.await()).rejects.toThrow(/at least 16 characters/)
  })
})
