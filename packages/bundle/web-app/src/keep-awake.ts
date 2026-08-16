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
  command: string
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

/** Test hook: substitutes the inhibitor spawn; production always uses the platform command. */
export const internals: { spawnInhibitor: (inhibitor: InhibitorCommand) => ChildProcess } = {
  spawnInhibitor: inhibitor => spawn(inhibitor.command, inhibitor.args, {
    // Credential scrub per docs/defensive-patterns.md: the inhibitor needs no
    // harness environment, and stdio stays detached from the URL-line stdout.
    env: scrubbedParentEnv(),
    stdio: 'ignore',
  }),
}

/**
 * Hold the sleep inhibitor while this plugin lives. Activation resolves only
 * after the child has spawned; a spawn failure (missing platform binary)
 * rejects the load. Disposal kills the child and awaits its exit.
 * @param ctx - plugin context.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const child = internals.spawnInhibitor(resolveInhibitor(process.platform))
  // 'error' before 'spawn' (ENOENT and friends) rejects activation loudly.
  await once(child, 'spawn')
  let disposed = false
  child.once('exit', (code, signal) => {
    if (disposed) return
    ctx.logger.warn(`web-keep-awake: sleep inhibitor exited (code ${String(code)}, signal ${String(signal)}); the host may sleep again`)
  })
  ctx.effect(() => async () => {
    disposed = true
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }, 'web-keep-awake: sleep inhibitor')
}
