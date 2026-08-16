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
    env: scrubbedParentEnv(),
    // Detached from stdout, which carries the URL readiness line.
    stdio: 'ignore',
    // POSIX group leader: `systemd-inhibit` forwards no signal to its own
    // `sleep` child, so signalling only the direct child orphans that one.
    detached: process.platform !== 'win32',
  }),
  terminateInhibitor: (child) => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') child.kill()
      else process.kill(-pid, 'SIGTERM')
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      // ESRCH is the wanted end state. Anything else (EPERM from a recycled
      // pid's group) leaves a child that may still hold the inhibitor.
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
  // `events.once` dropped its temporary 'error' handler on resolve, and a
  // ChildProcess with none throws on the next one, killing the dsh process.
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
    // 'exit' alone: an 'error' here must not reject teardown.
    const exited = new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
    const failure = internals.terminateInhibitor(child)
    if (failure !== undefined) {
      // No 'exit' is coming, so awaiting one would hang teardown.
      ctx.logger.warn(`web-keep-awake: could not release the sleep inhibitor (${failure.message}); process ${String(child.pid)} may keep the host awake until it is killed`)
      return
    }
    await exited
  }, 'web-keep-awake: sleep inhibitor')
}
