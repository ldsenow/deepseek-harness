/** Sleep-inhibitor plugin: platform command resolution, hold lifecycle, and fail-loud spawn. */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, resolveInhibitor } from '../src/keep-awake.ts'

/** Scriptable subprocess seam: records the spec and drives the handle's outcome by hand. */
function fakeSubprocess(handle: Partial<SubprocessHandle>, spawned: SubprocessSpawnSpec[] = []): SubprocessRuntime {
  return {
    spawn(spec: SubprocessSpawnSpec) {
      spawned.push(spec)
      return { pid: 4242, terminate: () => {}, waitForExit: async () => true, ...handle } as SubprocessHandle
    },
  } as SubprocessRuntime
}

/** Mount the plugin over a substituted seam and hand back the warning sink. */
async function mount(runtime: SubprocessRuntime, enabled = true) {
  const warn = vi.fn()
  const ctx = new Context()
  ctx.provide('subprocess', runtime)
  Object.defineProperty(ctx, 'logger', { value: { warn, error: vi.fn() }, configurable: true })
  return { warn, ctx, fiber: ctx.plugin({ inject: [...inject], apply }, new Config({ enabled })) }
}

describe('web-keep-awake module', () => {
  it('exposes the function-plugin export face the Loader requires', async () => {
    // A default export would make the Loader discard the namespace, and the
    // synthetic row in the Loader test below cannot catch that (it declares
    // the protocol itself), so the real module is asserted here.
    const module = await import('../src/keep-awake.ts')
    expect('default' in module).toBe(false)
    expect(module.name).toBe('web-keep-awake')
    expect(module.inject).toEqual(['subprocess'])
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

describe('web-keep-awake plugin', () => {
  it('spawns nothing when disabled', async () => {
    const spawned: SubprocessSpawnSpec[] = []
    const { fiber, ctx } = await mount(fakeSubprocess({ done: new Promise(() => {}) }, spawned), false)
    await fiber
    expect(spawned).toEqual([])
    await ctx.fiber.dispose()
  })

  it('holds the platform inhibitor for the plugin lifetime and awaits the tree on dispose', async () => {
    const spawned: SubprocessSpawnSpec[] = []
    let terminated = 0
    let awaited = 0
    const { warn, fiber } = await mount(fakeSubprocess({
      done: new Promise(() => {}),
      terminate: () => { terminated += 1 },
      waitForExit: async () => { awaited += 1; return true },
    }, spawned))
    await fiber.await()
    const { command, args } = resolveInhibitor(process.platform)
    expect(spawned[0]?.argv).toEqual([command, ...args])
    // Both streams off the URL readiness line, and a grace window the seam
    // escalates through so a signal-ignoring inhibitor cannot hang teardown.
    expect(spawned[0]?.stdio.stdin).toBe('ignore')
    expect(spawned[0]?.graceMs).toBeGreaterThan(0)
    expect(terminated).toBe(0)
    await fiber.dispose()
    expect([terminated, awaited]).toEqual([1, 1])
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when the inhibitor exits while serving', async () => {
    const { warn, fiber, ctx } = await mount(fakeSubprocess({
      done: Promise.resolve({ exitCode: 1, signal: null }),
    }))
    await fiber.await()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('exited (code 1'))
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the host may sleep again'))
    await ctx.fiber.dispose()
  })

  it('stays silent when the inhibitor exits because disposal asked it to', async () => {
    let settle: (() => void) | undefined
    const done = new Promise<SubprocessOutcome>((resolve) => {
      settle = () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }
    })
    const { warn, fiber } = await mount(fakeSubprocess({ done, terminate: () => { settle?.() } }))
    await fiber.await()
    await fiber.dispose()
    await done
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns when the seam reports a failure after the child was running', async () => {
    // pid means the spawn landed, so this is not an activation failure; the
    // hold is gone all the same.
    const { warn, fiber, ctx } = await mount(fakeSubprocess({
      done: Promise.reject(new Error('tree observation lost')),
    }))
    await fiber.await()
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed (Error: tree observation lost)'))
    })
    await ctx.fiber.dispose()
  })

  it('rejects activation when the platform binary is missing', async () => {
    // No pid means the spawn itself failed; the seam carries the reason on `done`.
    const { fiber, ctx } = await mount(fakeSubprocess({
      pid: -1,
      done: Promise.reject(new Error('spawn caffeinate ENOENT')),
    }))
    await expect(fiber).rejects.toThrow(/ENOENT/)
    await ctx.fiber.dispose()
  })

  it('holds a real child through a real Loader composition and releases the tree', async () => {
    // REAL-composition proof: the flag-shaped row boots through the vendored
    // Loader over the shipped subprocess provider, exactly as the bundle patch
    // mounts it. Only the platform binary is substituted (a plain Node
    // sleeper), because caffeinate/systemd-inhibit are absent in CI.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-keep-awake-'))
    writeFileSync(join(dir, 'provider.mjs'), [
      "export const name = 'web-startup'",
      'export function apply(ctx) { ctx.provide("webStartup", { trustedHosts: [], keepAwake: true }); ctx.provide("subprocess", globalThis.__seam) }',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'keep-awake.mjs'), [
      "export const name = 'web-keep-awake'",
      "export const inject = ['webStartup', 'subprocess']",
      'export const apply = (ctx, config) => globalThis.__keepAwakeApply(ctx, config)',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: keep-awake',
      `  name: ${pathToFileURL(join(dir, 'keep-awake.mjs')).href}`,
      '  inject: [webStartup, subprocess]',
      '  config:',
      '    enabled: !!js ctx.webStartup.keepAwake === true',
      '- id: provider',
      `  name: ${pathToFileURL(join(dir, 'provider.mjs')).href}`,
      '',
    ].join('\n'))
    // The shipped provider does the real spawning, terminating, and exit
    // observation; only the argv is swapped, because caffeinate and
    // systemd-inhibit are absent in CI.
    const provider = new Context()
    await provider.plugin(SubprocessLocal)
    const held: SubprocessHandle[] = []
    const globals = globalThis as unknown as { __keepAwakeApply: typeof apply; __seam: SubprocessRuntime }
    globals.__keepAwakeApply = apply
    globals.__seam = {
      spawn: (spec: SubprocessSpawnSpec) => {
        const handle = provider.subprocess.spawn({ ...spec, argv: [process.execPath, '-e', 'setTimeout(() => {}, 120000)'] })
        held.push(handle)
        return handle
      },
    } as SubprocessRuntime

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    // World verification: one live inhibitor while the tree lives, none after.
    expect(held).toHaveLength(1)
    expect(held[0]!.pid).toBeGreaterThan(0)
    await ctx.fiber.dispose()
    expect(await held[0]!.waitForExit()).toBe(true)
    await provider.fiber.dispose()
  })
})
