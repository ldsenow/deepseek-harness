/**
 * The Web command-line provider over a real Loader tree: its ordinary service
 * releases a consumer whose config reads `ctx.webStartup` directly.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, WEB_STARTUP_SERVICE, type WebStartupValues } from '../src/startup.ts'

/** What one fixture boot observed. */
interface Observed {
  exits: number[]
  out: string
  readerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []
const TOKEN_VAR = 'DSH_TEST_PAIRING_TOKEN'

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  delete process.env.DSH_TEST_PAIRING_TOKEN
})

/**
 * Mount the real provider and a consumer using injection-ordered config.
 * @param args - the invocation's inner arguments.
 * @returns the service value and observed consumer/process effects.
 */
async function bootProvider(args: string[]): Promise<{
  values: WebStartupValues | undefined
  observed: Observed
}> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-startup-'))
  const observed: Observed = { exits: [], out: '' }
  writeFileSync(join(dir, 'reader.mjs'), `
export function apply(_ctx, config) { globalThis.__webStartupObserved.readerConfig = config }
`)
  // Node imports the fixture row outside Vite's source resolver, so delegate
  // to the source-plane plugin already imported by this test.
  writeFileSync(join(dir, 'provider.mjs'), `
export const name = 'web-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__webStartupApply(ctx)
`)
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: reader',
    `  name: ${pathToFileURL(join(dir, 'reader.mjs')).href}`,
    `  inject: [${WEB_STARTUP_SERVICE}]`,
    '  config:',
    "    host: !!js ctx.webStartup.host ?? '127.0.0.1'",
    '    port: !!js ctx.webStartup.port ?? 3080',
    '    trustedHosts: !!js ctx.webStartup.trustedHosts',
    '    pairingToken: !!js ctx.webStartup.pairingToken',
    '    keepAwake: !!js ctx.webStartup.keepAwake',
    '- id: provider',
    `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  internals.stdout = observing
  internals.stderr = observing
  const globals = globalThis as unknown as {
    __webStartupApply: typeof apply
    __webStartupObserved: Observed
  }
  globals.__webStartupApply = apply
  globals.__webStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    values: ctx.get(WEB_STARTUP_SERVICE) as WebStartupValues | undefined,
    observed,
  }
}

describe('web command-line provider', () => {
  it('publishes each flag and releases direct service expressions', async () => {
    const { values, observed } = await bootProvider([
      '--host', '127.0.0.1',
      '--port', '8080',
      '--trusted-host', 'lab.internal', 'lab-2.internal',
      '--trusted-host', '10.0.0.9',
      '--pairing-token', 'startup-pairing-token_01',
      '--keep-awake',
    ])
    expect(values).toEqual({
      host: '127.0.0.1',
      port: 8080,
      trustedHosts: ['lab.internal', 'lab-2.internal', '10.0.0.9'],
      pairingToken: 'startup-pairing-token_01',
      keepAwake: true,
    })
    expect(observed.readerConfig).toEqual(values)
    expect(observed.exits).toEqual([])
  })

  it('leaves deployment values to each consumer when flags omit them', async () => {
    const { values, observed } = await bootProvider([])
    expect(values).toEqual({ trustedHosts: [] })
    expect(observed.readerConfig).toEqual({
      host: '127.0.0.1',
      port: 3080,
      trustedHosts: [],
    })
  })

  it('prints its own help and leaves the consumer pending', async () => {
    const { values, observed } = await bootProvider(['--help'])
    expect(observed.out).toContain('dsh --profile web')
    expect(observed.out).toContain('--trusted-host')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })

  it('rejects a non-numeric port before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--port', 'abc'])
    expect(observed.out).toContain('--port must be a number')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects the all-interfaces host without a pairing token before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0'])
    expect(observed.out).toContain('--host 0.0.0.0 exposes remote code execution to the network, so it requires --pairing-token-env')
    expect(values).toBeUndefined()
    expect(observed.readerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes the all-interfaces host once a pairing token accompanies it', async () => {
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--pairing-token', 'startup-pairing-token_01'])
    expect(values).toEqual({
      host: '0.0.0.0',
      trustedHosts: [],
      pairingToken: 'startup-pairing-token_01',
    })
    expect(observed.exits).toEqual([])
  })

  it('reads the token from the named variable, keeping it out of the argument list', async () => {
    process.env[TOKEN_VAR] = 'startup-pairing-token_01'
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--pairing-token-env', TOKEN_VAR])
    expect(values).toEqual({
      host: '0.0.0.0',
      trustedHosts: [],
      pairingToken: 'startup-pairing-token_01',
    })
    expect(observed.exits).toEqual([])
  })

  it.each([
    ['unset', undefined],
    // An exported-but-empty variable is the shape a shell leaves behind when
    // the generator that should have filled it failed; admitting it would
    // serve the LAN with no token at all.
    ['empty', ''],
  ])('rejects a %s variable named by --pairing-token-env', async (_kind, value) => {
    if (value !== undefined) process.env[TOKEN_VAR] = value
    const { values, observed } = await bootProvider(['--host', '0.0.0.0', '--pairing-token-env', TOKEN_VAR])
    expect(observed.out).toContain(`--pairing-token-env names "${TOKEN_VAR}", which is not set`)
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects both token forms at once rather than silently preferring one', async () => {
    process.env[TOKEN_VAR] = 'startup-pairing-token_01'
    const { values, observed } = await bootProvider([
      '--pairing-token-env', TOKEN_VAR,
      '--pairing-token', 'startup-pairing-token_02',
    ])
    expect(observed.out).toContain('pass either --pairing-token-env or --pairing-token, not both')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it.each([
    ['the literal flag', ['--pairing-token', 'short'], undefined],
    ['a referenced variable', ['--pairing-token-env', TOKEN_VAR], 'short'],
  ])('rejects a malformed pairing token from %s', async (_kind, args, envValue) => {
    if (envValue !== undefined) process.env[TOKEN_VAR] = envValue
    const { values, observed } = await bootProvider(args)
    expect(observed.out).toContain('the pairing token must be at least 16 characters of A-Za-z0-9_-')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects trusted authorities without a pairing token before the consumer activates', async () => {
    const { values, observed } = await bootProvider(['--trusted-host', 'lab.internal'])
    expect(observed.out).toContain('--trusted-host requires a pairing token')
    expect(values).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })
})
