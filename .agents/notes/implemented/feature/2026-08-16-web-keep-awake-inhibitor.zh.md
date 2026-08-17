# Agent Note: `--keep-awake` 持有平台睡眠抑制器

Status: implemented

[English](2026-08-16-web-keep-awake-inhibitor.md) | 中文

## 问题

向[已配对 LAN 设备](2026-08-15-web-lan-pairing-token-tls.md)提供 Web GUI 的 PC，在所有者从手机上工作时，从 OS 的视角看是空闲的：键盘无人触碰，空闲睡眠于是在会话中途挂起机器，杀死运行中的 agent 和所有配对连接。这类部署需要一个可选项，让宿主恰好在 dsh 提供服务期间保持唤醒。

## 决定

`dsh --profile web --keep-awake` 挂载 `web-keep-awake` 插件（`@deepseek-ai/dsh-web-app/keep-awake`，配置为 `{enabled}`），在插件生命周期内持有一个平台自有的抑制器子进程：macOS 上是 `caffeinate -i`，Linux 上是 `systemd-inhibit --what=sleep:idle --mode=block sleep infinity`，Windows 上是持有 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` 的 PowerShell 子进程。委托给 OS 让锁不落在 dsh 自身的状态里：由子进程持有，子进程退出时 OS 释放它。子进程走 [subprocess 能力缝](../../../../packages/subprocess/subprocess/README.md)，它本就持有剔除凭据的环境、进程树，以及 SIGTERM 转 SIGKILL 的升级；dispose（资源释放）调用 `terminate()` 并等待整棵树，等待有上界、超过宽限窗口（按[防御模式](../../../../docs/defensive-patterns.md)达到完全停稳，但无法送达的信号——被复用的组 id 上的 EPERM、无法杀死的成员——绝不能把 dsh 关停拖死；超时后 disposer 记录警告并放走孤儿进程，与被 `SIGKILL` 的 dsh 结果相同）。在本地自行持有这套终止逻辑，代价是两个该缝并不存在的缺陷：只对直接子进程发信号会留下 `systemd-inhibit` 自己的 `sleep` 存活，而在抑制器忽略信号后等待退出会让拆卸永远挂住。被强行结束的 dsh 进程（`SIGKILL`、断电）不会执行 dispose，因此子进程成为孤儿并继续持有抑制器，直到它被杀死或机器重启。没有产生 pid 的 spawn 会让激活报错，因此要求保持唤醒的调用不会在没有抑制器的情况下继续服务；子进程之后退出则记录警告，服务继续。

## 考虑过的替代方案

- **直接调用电源 API 的原生插件。** 否决：三个平台绑定的构建与发布（仓库仅有的一个原生插件已经是维护成本）对比三个内置可执行文件；而且进程内的锁只能和我们自己的拆卸一样可靠，子进程持有的锁则由内核在任何死亡时释放。
- **npm keep-awake 依赖。** 否决：候选者都是包着同样三条命令的薄且无人维护的包装层；依赖必须能删除自有代码，而这里它只会替换一个 `switch`。
- **在本插件内自持 spawn 与进程组终止。** 试过并已回退：它复制了 subprocess 能力缝，并在该缝本已做对的两处（树终止与信号升级）与之漂移，因此本插件如今只提供 argv 与宽限窗口。
- **只在会话活跃时抑制。** 暂缓：把持有与 agent 活动绑定需要一个空闲定义（排队的 follow-up、后台任务、已配对但空闲的设备，对手机前的人来说都算「在用」）。进程生命周期的持有可预测，且与显式 flag 匹配。
- **`--host 0.0.0.0` 时始终开启。** 否决：让机器无限期保持唤醒是所有者做出的电源决定，不是 LAN 服务的副作用。

## 后果

- 该 flag 在组合包启动的任何地方都可组合——仅回环的服务也可以持有它（长时间的本地会话有同样的空闲睡眠问题）。
- 只抑制空闲睡眠：合盖与显式挂起在所有平台上仍是 OS 策略，显示器也可能照常熄灭（记录在 web-app README）。
- 缺少平台二进制的宿主（无 systemd 的 Linux 上没有 `systemd-inhibit`）在传入该 flag 时启动明确报错；不传 flag 则什么也不会生成。
