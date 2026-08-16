# Agent Note: `--keep-awake` 持有平台睡眠抑制器

Status: implemented

[English](2026-08-16-web-keep-awake-inhibitor.md) | 中文

## 问题

向[已配对 LAN 设备](2026-08-15-web-lan-pairing-token-tls.md)提供 Web GUI 的 PC，在所有者从手机上工作时，从 OS 的视角看是空闲的：键盘无人触碰，空闲睡眠于是在会话中途挂起机器，杀死运行中的 agent 和所有配对连接。这类部署需要一个可选项，让宿主恰好在 dsh 提供服务期间保持唤醒。

## 决定

`dsh --profile web --keep-awake` 挂载 `web-keep-awake` 插件（`@deepseek-ai/dsh-web-app/keep-awake`，配置为 `{enabled}`），在插件生命周期内持有一个平台自有的抑制器子进程：macOS 上是 `caffeinate -i`，Linux 上是 `systemd-inhibit --what=sleep:idle --mode=block sleep infinity`，Windows 上是持有 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` 的 PowerShell 子进程。委托给 OS 设施让释放变得无条件：锁随子进程死亡而消失，子进程随 dsh 死亡而消失，因此任何崩溃路径都不可能留下一台永不睡眠的机器。激活会等待子进程的 `spawn` 并在失败时报错——要求保持唤醒的调用绝不悄悄在没有抑制器的情况下继续服务；抑制器之后死掉只记录警告，因为失去抑制器不能拖垮服务。dispose（资源释放）杀死子进程并等待其退出（按[防御模式](../../../../docs/defensive-patterns.md)达到完全停稳），子进程在 `scrubbedParentEnv()` 下运行，harness 凭据永远不会到达它。

## 考虑过的替代方案

- **直接调用电源 API 的原生插件。** 否决：三个平台绑定的构建与发布（仓库仅有的一个原生插件已经是维护成本）对比三个内置可执行文件；而且进程内的锁只能和我们自己的拆卸一样可靠，子进程持有的锁则由内核在任何死亡时释放。
- **npm keep-awake 依赖。** 否决：候选者都是包着同样三条命令的薄且无人维护的包装层；依赖必须能删除自有代码，而这里它只会替换一个 `switch`。
- **只在会话活跃时抑制。** 暂缓：把持有与 agent 活动绑定需要一个空闲定义（排队的 follow-up、后台任务、已配对但空闲的设备，对手机前的人来说都算「在用」）。进程生命周期的持有可预测，且与显式 flag 匹配。
- **`--host 0.0.0.0` 时始终开启。** 否决：让机器无限期保持唤醒是所有者做出的电源决定，不是 LAN 服务的副作用。

## 后果

- 该 flag 在组合包启动的任何地方都可组合——仅回环的服务也可以持有它（长时间的本地会话有同样的空闲睡眠问题）。
- 只抑制空闲睡眠：合盖与显式挂起在所有平台上仍是 OS 策略，显示器也可能照常熄灭（记录在 web-app README）。
- 缺少平台二进制的宿主（无 systemd 的 Linux 上没有 `systemd-inhibit`）在传入该 flag 时启动明确报错；不传 flag 则什么也不会生成。
