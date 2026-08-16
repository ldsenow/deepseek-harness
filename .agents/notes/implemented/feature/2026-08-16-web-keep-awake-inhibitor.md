# Agent Note: `--keep-awake` holds the platform sleep inhibitor

Status: implemented

English | [中文](2026-08-16-web-keep-awake-inhibitor.zh.md)

## Problem

A PC serving the web GUI to [paired LAN devices](2026-08-15-web-lan-pairing-token-tls.md) goes idle from the OS's point of view while the owner works from the phone: the keyboard is untouched, so idle sleep suspends the machine mid-session, killing running agents and every paired connection. The deployment needs an opt-in way to keep the host awake for exactly as long as dsh serves.

## Decision

`dsh --profile web --keep-awake` mounts the `web-keep-awake` plugin (`@deepseek-ai/dsh-web-app/keep-awake`, config `{enabled}`), which holds one platform-owned inhibitor child for the plugin lifetime: `caffeinate -i` on macOS, `systemd-inhibit --what=sleep:idle --mode=block sleep infinity` on Linux, and a PowerShell child holding `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on Windows. Delegating to the OS facility makes release unconditional: the lock dies with the child, and the child dies with dsh, so no crash path can leave a machine that never sleeps. Activation awaits the child's `spawn` and rejects on failure — an invocation that asked to stay awake must never silently serve without the inhibitor — while an inhibitor dying later only logs a warning, because losing the inhibitor must not take down serving. Disposal kills the child and awaits its exit (quiescence per [defensive patterns](../../../../docs/defensive-patterns.md)), and the child runs under `scrubbedParentEnv()` so harness credentials never reach it.

## Alternatives considered

- **A native addon calling the power APIs directly.** Rejected: three platform bindings to build and ship (the repo's one native addon is already a maintenance cost) versus three built-in executables; and an in-process lock would survive only as cleanly as our own teardown, while a child-held lock is released by the kernel on any death.
- **An npm keep-awake dependency.** Rejected: the candidates are thin unmaintained wrappers around the same three commands; a dependency must delete owned code, and here it would replace one `switch`.
- **Inhibiting only while a session is active.** Deferred: tying the hold to agent activity needs an idle definition (queued follow-ups, background jobs, paired-but-idle devices all count as "in use" to the person on the phone). Process-lifetime hold is predictable and matches the explicit flag.
- **Always-on with `--host 0.0.0.0`.** Rejected: keeping a machine awake indefinitely is a power decision the owner makes, not a side effect of LAN serving.

## Consequences

- The flag composes anywhere the bundle boots — loopback-only serving may hold it too (a long local session has the same idle-sleep problem).
- Idle sleep only: lid-close and explicit suspend remain OS policy on every platform, and the display may still turn off (documented in the web-app README).
- A host without its platform binary (`systemd-inhibit` on a non-systemd Linux) fails the boot loudly when the flag is passed; without the flag nothing is spawned.
