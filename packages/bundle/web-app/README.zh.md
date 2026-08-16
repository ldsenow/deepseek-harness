# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

dsh 浏览器表层组合包。[`cordis.patch.yml`](cordis.patch.yml) 叠加在 [`dsh-base`](../base/README.md) 之上：设置 coding persona，插入 Web 宿主行（webserver、API 网关、workspace、投影缓存、存储）、浏览器插件名录与始终挂载的客户端插件重载链（[`dsh-client-hmr`](../../client/hmr/README.md)，在重建 watcher 改写客户端 bundle 之前保持空闲），并挂载本包的 `web-runtime` 粘合插件（配置为 `{printUrl, surfaceContext, trustedHosts, pairingToken}`）。该插件通过 `@deepseek-ai/dsh-web-frontend` 的 exports 解析已构建的前端 dist，只采样一次依赖 bind 的 LAN 信任信息并连同配对 token 作为 `webRuntime` 提供给浏览器信任栅栏和客户端名录，挂载 [`frontend-static`](../../host/frontend-static/README.md) 回退席位所有者，在 `surfaceContext` 为 true 时注册 Harness 源码与 Web 表层提示词段落，以及 bash 可见的 `DSH_WEB_URL` 运行时变量，并在 `printUrl` 为 true 时等自身的 Loader 配置树结算后再打印 `dsh web:` URL 行，避免兄弟行失败时公告一个已失效的应用。本组合包还持有应用命令行：普通 `web-startup` 提供方（[`src/startup.ts`](src/startup.ts)）注入 `ctx.cmdlineArgs`（[`dsh-cmdline`](../../boot/cmdline/README.md)），解析 `--host`、`--port`、可重复的 `--trusted-host`、`--pairing-token`、`--keep-awake` 以及应用自己的 `--help`，再提供 `webStartup`。由 flag 配置的行会注入该服务，并在惰性配置中直接读取它，因此参数解析完成前不会有任何东西绑定端口，`dsh --profile web --help` 也不会启动服务器。[`dsh-headless`](../headless/README.md) 是同一 base 之上的同级表层，不挂载本组合包。

## LAN 服务：配对 token + TLS

`dsh --profile web --host 0.0.0.0 --pairing-token <token>` 把 GUI 服务到本地网络；`--host 0.0.0.0` 或 `--trusted-host` 不带有效 token 是用法错误，因为 [connection 插件](../../client/connection/README.md)不会放行任何非回环调用方。绑定所有网络接口同时启用 TLS：`web-tls` 提供方（[`src/tls.ts`](src/tls.ts)，配置为 `{enabled, dir}`）在 `dshHomePath('web-tls')` 下一次性生成自签名证书（SAN：回环名加生成时采样的 LAN 地址；十年有效期；密钥仅属主可读），并把 PEM 路径交给 webserver 行，因此重启后设备已接受的证书保持不变。打印的 LAN 行就是配对 URL `https://<lan-ip>:<port>/#auth=<token>`，设备打开一次即可。回环绑定不提供 TLS 路径，保持明文 HTTP。

`--keep-awake` 在进程生命周期内持有平台的睡眠抑制器（`web-keep-awake`，[`src/keep-awake.ts`](src/keep-awake.ts)，配置为 `{enabled}`）：macOS 上是 `caffeinate -i`，Linux 上是 `systemd-inhibit --what=sleep:idle --mode=block`，Windows 上是持有 `SetThreadExecutionState` 的 PowerShell 子进程，各自在子进程或 dsh 进程死亡时释放。抑制器无法启动时激活报错；之后死掉则只记录警告，服务继续。子进程使用剔除凭据的环境运行。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致，而不在既有证书 SAN 中的 LAN 地址只会重新触发浏览器警告。
- **直接输入裸 `ip:port` 可能先拨 `http://`**：部分浏览器对输入的权威默认走明文 HTTP，而 TLS 端口会拒绝它；打开一次打印出的 `https://` 配对链接后，浏览器此后会自动补全 `https`。有意不在同一端口上实现双协议嗅探。
- **`--keep-awake` 只抑制空闲睡眠**：合上笔记本盖子在所有平台上仍会睡眠（合盖动作是抑制器无法覆盖的 OS 策略），显示器也可能照常熄灭。
