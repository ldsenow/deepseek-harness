/** Sleep-inhibitor plugin: platform command resolution, hold lifecycle, and fail-loud spawn. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, internals, resolveInhibitor, type InhibitorCommand } from '../src/keep-awake.ts'

const originalSpawn = internals.spawnInhibitor

afterEach(() => {
  internals.spawnInhibitor = originalSpawn
  vi.restoreAllMocks()
})

/** Structural inhibitor child: spawn/exit are test-driven; kill records and reports exit. */
class FakeInhibitor extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => {
      this.signalCode = 'SIGTERM'
      this.emit('exit', null, 'SIGTERM')
    })
    return true
  }

  /** Complete the spawn handshake on the next microtask (the real child emits 'spawn' asynchronously). */
  spawnOk(): this {
    queueMicrotask(() => { this.emit('spawn') })
    return this
  }
}

function asChild(fake: FakeInhibitor): ChildProcess {
  return fake as unknown as ChildProcess
}

describe('resolveInhibitor', () => {
  it('maps each platform to its own sleep facility', () => {
    expect(resolveInhibitor('darwin')).toEqual({ command: 'caffeinate', args: ['-i'] })
    expect(resolveInhibitor('linux').command).toBe('systemd-inhibit')
    expect(resolveInhibitor('linux').args).toContain('--what=sleep:idle')
    const windows = resolveInhibitor('win32')
    expect(windows.command).toBe('powershell')
    expect(windows.args.join(' ')).toContain('SetThreadExecutionState')
  })
})

describe('web-keep-awake plugin', () => {
  it('spawns nothing when disabled', async () => {
    const spawned: InhibitorCommand[] = []
    internals.spawnInhibitor = (command) => { spawned.push(command); throw new Error('unreachable') }
    const ctx = new Context()
    await ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: false }))
    expect(spawned).toEqual([])
    await ctx.fiber.dispose()
  })

  it('holds the inhibitor for the plugin lifetime and awaits its exit on dispose', async () => {
    const fake = new FakeInhibitor()
    const spawned: InhibitorCommand[] = []
    internals.spawnInhibitor = (command) => { spawned.push(command); return asChild(fake.spawnOk()) }
    const warn = vi.fn()
    const ctx = new Context()
    Object.defineProperty(ctx, 'logger', { value: { warn }, configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await fiber.await()
    expect(spawned).toEqual([resolveInhibitor(process.platform)])
    expect(fake.killed).toBe(false)
    await fiber.dispose()
    expect(fake.killed).toBe(true)
    expect(fake.signalCode).toBe('SIGTERM')
    // The disposal-initiated exit is expected: no "may sleep again" warning.
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when the inhibitor dies while serving, and dispose then has nothing to kill', async () => {
    const fake = new FakeInhibitor()
    internals.spawnInhibitor = () => asChild(fake.spawnOk())
    const warn = vi.fn()
    const ctx = new Context()
    Object.defineProperty(ctx, 'logger', { value: { warn }, configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await fiber.await()
    fake.exitCode = 1
    fake.emit('exit', 1, null)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the host may sleep again'))
    await fiber.dispose()
    expect(fake.killed).toBe(false)
  })

  it('rejects activation when the inhibitor cannot start', async () => {
    const fake = new FakeInhibitor()
    internals.spawnInhibitor = () => {
      queueMicrotask(() => { fake.emit('error', new Error('spawn caffeinate ENOENT')) })
      return asChild(fake)
    }
    const ctx = new Context()
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await expect(fiber).rejects.toThrow(/ENOENT/)
    await ctx.fiber.dispose()
  })

  it('holds a real child through a real Loader composition and releases it with the tree', async () => {
    // REAL-composition proof: the flag-shaped row boots through the vendored
    // Loader exactly as the bundle patch mounts it; only the platform binary
    // is substituted (a plain Node sleeper), because caffeinate/systemd-inhibit
    // are absent in CI.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-keep-awake-'))
    writeFileSync(join(dir, 'provider.mjs'), [
      "export const name = 'web-startup'",
      'export function apply(ctx) { ctx.provide("webStartup", { trustedHosts: [], keepAwake: true }) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'keep-awake.mjs'), [
      "export const name = 'web-keep-awake'",
      "export const inject = ['webStartup']",
      'export const apply = (ctx, config) => globalThis.__keepAwakeApply(ctx, config)',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: keep-awake',
      `  name: ${pathToFileURL(join(dir, 'keep-awake.mjs')).href}`,
      '  inject: [webStartup]',
      '  config:',
      '    enabled: !!js ctx.webStartup.keepAwake === true',
      '- id: provider',
      `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
      '',
    ].join('\n'))
    const globals = globalThis as unknown as { __keepAwakeApply: typeof apply }
    globals.__keepAwakeApply = apply
    const held: ChildProcess[] = []
    internals.spawnInhibitor = () => {
      const child = originalSpawn({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 120000)'] })
      held.push(child)
      return child
    }

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])
    // World verification: one live inhibitor while the tree lives, none after.
    expect(held).toHaveLength(1)
    expect(held[0]!.exitCode).toBeNull()
    expect(held[0]!.signalCode).toBeNull()
    await ctx.fiber.dispose()
    expect(held[0]!.exitCode !== null || held[0]!.signalCode !== null).toBe(true)
  })

  it('holds a real scrubbed-env child through the default spawn and releases it on dispose', async () => {
    // The default internals.spawnInhibitor with a real process: platform
    // binaries are absent in CI, so the command under test is a plain Node
    // sleeper — the spawn/kill/await-exit lifecycle is what this proves.
    const sleeper: InhibitorCommand = { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 120000)'] }
    const child = originalSpawn(sleeper)
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    expect(child.pid).toBeGreaterThan(0)
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    child.kill()
    await exited
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})
