/**
 * The web app's host sleep inhibitor: while enabled, holds a platform
 * keep-awake child process for the dsh process lifetime so idle sleep cannot
 * cut off running sessions or paired LAN devices. The inhibitor is the
 * platform's own facility — `caffeinate -i` on macOS, `systemd-inhibit` on
 * Linux, a PowerShell `SetThreadExecutionState` holder on Windows — so
 * disposal or process death always releases the lock with the child. An
 * inhibitor that cannot start rejects activation: a deployment that asked to
 * stay awake must never silently serve without it. An inhibitor that dies
 * later logs a warning and serving continues.
 * @module @deepseek-ai/dsh-web-app/keep-awake
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Stable Cordis plugin name. */
export const name = 'web-keep-awake'

/** Required services (none — the inhibitor rides the plugin lifetime alone). */
export const inject: string[] = []

/** Plugin config: whether this invocation holds the host awake. */
export interface Config {
  /** Hold the platform sleep inhibitor for the process lifetime. */
  enabled: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().required(),
})

/** One platform sleep-inhibitor invocation. */
export interface InhibitorCommand {
  /** Executable holding the platform's inhibitor for as long as it runs. */
  command: string
  /** Arguments passed as an argv array, never a shell string. */
  args: string[]
}

/**
 * ES_CONTINUOUS | ES_SYSTEM_REQUIRED held for the child's lifetime; Windows
 * clears the state automatically when the holding process dies, so no
 * release call exists or is needed.
 */
const WINDOWS_HOLD = [
  'Add-Type -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\' -Name PowerState -Namespace DshKeepAwake | Out-Null;',
  '[DshKeepAwake.PowerState]::SetThreadExecutionState(0x80000001) | Out-Null;',
  'while ($true) { Start-Sleep -Seconds 3600 }',
].join(' ')

/**
 * Resolve the platform's sleep-inhibitor invocation.
 * @param platform - `process.platform` of the host.
 * @returns the command and arguments to hold for the process lifetime.
 */
export function resolveInhibitor(platform: NodeJS.Platform): InhibitorCommand {
  switch (platform) {
    case 'darwin':
      // -i inhibits idle system sleep only; the display may still sleep.
      return { command: 'caffeinate', args: ['-i'] }
    case 'win32':
      return { command: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOLD] }
    default:
      return {
        command: 'systemd-inhibit',
        args: ['--what=sleep:idle', '--who=dsh', '--why=Serving the DSH web GUI', '--mode=block', 'sleep', 'infinity'],
      }
  }
}

/**
 * Test hooks: substitute spawn and termination; production always uses the
 * platform command and a group signal. `terminateInhibitor` returns the signal
 * failure when the child may still be holding the inhibitor, and `undefined`
 * once the group is gone or on its way out.
 */
export const internals: {
  spawnInhibitor: (inhibitor: InhibitorCommand) => ChildProcess
  terminateInhibitor: (child: ChildProcess) => NodeJS.ErrnoException | undefined
} = {
  spawnInhibitor: inhibitor => spawn(inhibitor.command, inhibitor.args, {
    // Credential scrub per docs/defensive-patterns.md: the inhibitor needs no
    // harness environment, and stdio stays detached from the URL-line stdout.
    env: scrubbedParentEnv(),
    stdio: 'ignore',
    // POSIX: lead a new process group so teardown reaches the whole tree.
    // `systemd-inhibit` runs its own child (`sleep infinity`) and does not
    // forward signals, so killing only the direct child would leave that
    // grandchild running — disposal must reach quiescence, not just request
    // it. Windows has no process groups here; its holder spawns no child.
    detached: process.platform !== 'win32',
  }),
  terminateInhibitor: (child) => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill()
      // Negative pid signals the whole group, so `systemd-inhibit`'s own
      // `sleep` child dies with it instead of outliving teardown.
      else process.kill(-pid, 'SIGTERM')
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      // ESRCH means the group is already gone, which is the desired end state.
      // Anything else — EPERM above all, which is what a pid recycled between
      // the child's death and libuv observing it would raise — leaves a child
      // that may still hold the inhibitor, so the caller hears about it.
      return failure.code === 'ESRCH' ? undefined : failure
    }
    return undefined
  },
}

/**
 * Hold the sleep inhibitor while this plugin lives. Activation resolves only
 * after the child has spawned; a spawn failure (missing platform binary)
 * rejects the load. Disposal signals the child and awaits its exit, or warns
 * and returns when the signal itself failed.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const child = internals.spawnInhibitor(resolveInhibitor(process.platform))
  // 'error' before 'spawn' (ENOENT and friends) rejects activation loudly.
  await once(child, 'spawn')
  let disposed = false
  // `events.once` above removed its own temporary 'error' handler on resolve.
  // A ChildProcess with no 'error' listener throws on the next one, which
  // would take the whole dsh process down for a failure this plugin is
  // required to survive, so the listener is durable from here on.
  child.on('error', (error) => {
    if (disposed) return
    ctx.logger.warn(`web-keep-awake: sleep inhibitor failed (${error.message}); the host may sleep again`)
  })
  child.once('exit', (code, signal) => {
    if (disposed) return
    ctx.logger.warn(`web-keep-awake: sleep inhibitor exited (code ${String(code)}, signal ${String(signal)}); the host may sleep again`)
  })
  ctx.effect(() => async () => {
    disposed = true
    if (child.exitCode !== null || child.signalCode !== null) return
    // Settle on 'exit' alone: an 'error' must not reject teardown, and the
    // process is gone either way once one of them fires.
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    const failure = internals.terminateInhibitor(child)
    if (failure !== undefined) {
      // The signal never landed, so no 'exit' is coming and awaiting one would
      // hang teardown. Name the process instead: it may still hold the lock.
      ctx.logger.warn(`web-keep-awake: could not release the sleep inhibitor (${failure.message}); process ${String(child.pid)} may keep the host awake until it is killed`)
      return
    }
    await exited
  }, 'web-keep-awake: sleep inhibitor')
}
