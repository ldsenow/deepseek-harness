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
const originalTerminate = internals.terminateInhibitor
/** Restored after a test forces `process.platform` to exercise the Windows path. */
const PLATFORM = process.platform

/** Fakes carry no real pid, so termination routes to the fake's own kill, which always lands. */
function terminateFake(child: ChildProcess): undefined {
  child.kill()
  return undefined
}

afterEach(() => {
  internals.spawnInhibitor = originalSpawn
  internals.terminateInhibitor = originalTerminate
  vi.restoreAllMocks()
})

/** Structural inhibitor child: spawn/exit are test-driven; kill records and reports exit. */
class FakeInhibitor extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  pid: number | undefined = undefined

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

describe('web-keep-awake module', () => {
  it('exposes the function-plugin export face the Loader requires', async () => {
    // A default export would make the Loader discard the namespace, and the
    // synthetic row in the Loader test below cannot catch that (it declares
    // the protocol itself), so the real module is asserted here.
    const module = await import('../src/keep-awake.ts')
    expect('default' in module).toBe(false)
    expect(module.name).toBe('web-keep-awake')
    expect(module.inject).toEqual([])
  })
})

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

describe('terminateInhibitor', () => {
  it('does nothing for a child that never got a pid', () => {
    // A failed spawn leaves `pid` undefined; signalling group 0 from here would
    // hit this process's own group, so termination must be a no-op instead.
    const fake = new FakeInhibitor()
    const groupSignals = vi.spyOn(process, 'kill').mockImplementation(() => true)
    expect(originalTerminate(asChild(fake))).toBeUndefined()
    expect(fake.killed).toBe(false)
    expect(groupSignals).not.toHaveBeenCalled()
  })

  it('kills the process directly on Windows, where the holder leads no group', () => {
    const fake = new FakeInhibitor()
    fake.pid = 4242
    const groupSignals = vi.spyOn(process, 'kill').mockImplementation(() => true)
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      originalTerminate(asChild(fake))
    } finally {
      Object.defineProperty(process, 'platform', { value: PLATFORM, configurable: true })
    }
    expect(fake.killed).toBe(true)
    expect(groupSignals).not.toHaveBeenCalled()
  })

  it.each([
    ['ESRCH', undefined],
    ['EPERM', 'EPERM'],
  ])('reports a %s signal failure as %s', (code, reported) => {
    const fake = new FakeInhibitor()
    fake.pid = 4242
    const failure = Object.assign(new Error(`kill ${code}`), { code })
    // Both call sites throw, so the assertion holds on POSIX and Windows alike.
    fake.kill = () => { throw failure }
    vi.spyOn(process, 'kill').mockImplementation(() => { throw failure })
    expect(originalTerminate(asChild(fake))?.code).toBe(reported)
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
    internals.terminateInhibitor = terminateFake
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
    internals.terminateInhibitor = terminateFake
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

  it('survives an inhibitor error after spawn instead of crashing the process', async () => {
    // Without a durable listener this emit is an unhandled 'error'.
    const fake = new FakeInhibitor()
    internals.spawnInhibitor = () => asChild(fake.spawnOk())
    internals.terminateInhibitor = terminateFake
    const warn = vi.fn()
    const ctx = new Context()
    Object.defineProperty(ctx, 'logger', { value: { warn }, configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await fiber.await()
    expect(() => { fake.emit('error', new Error('kill EPERM')) }).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the host may sleep again'))
    // Teardown still completes: an 'error' must not reject the disposer.
    await fiber.dispose()
    expect(fake.killed).toBe(true)
  })

  it('stays silent about an error raised by teardown itself', async () => {
    // An 'error' raised by teardown itself is not a lost inhibitor.
    const fake = new FakeInhibitor()
    internals.spawnInhibitor = () => asChild(fake.spawnOk())
    internals.terminateInhibitor = (child) => {
      child.emit('error', new Error('kill ESRCH'))
      terminateFake(child)
      return undefined
    }
    const warn = vi.fn()
    const ctx = new Context()
    Object.defineProperty(ctx, 'logger', { value: { warn }, configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await fiber.await()
    await fiber.dispose()
    expect(fake.killed).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports a signal that never landed instead of waiting forever for an exit', async () => {
    // No 'exit' follows a failed signal, so teardown must not await one.
    const fake = new FakeInhibitor()
    fake.pid = 4242
    internals.spawnInhibitor = () => asChild(fake.spawnOk())
    internals.terminateInhibitor = () => Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    const warn = vi.fn()
    const ctx = new Context()
    Object.defineProperty(ctx, 'logger', { value: { warn }, configurable: true })
    const fiber = ctx.plugin({ inject: [...inject], apply }, new Config({ enabled: true }))
    await fiber.await()
    await fiber.dispose()
    expect(fake.killed).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not release the sleep inhibitor (kill EPERM)'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('process 4242'))
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
    // The production terminator: a POSIX group signal, so anything the
    // inhibitor spawned dies with it rather than outliving teardown.
    originalTerminate(child)
    await exited
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})
