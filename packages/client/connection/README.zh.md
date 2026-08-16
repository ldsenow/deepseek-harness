# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。回环判定来自 [`dsh-loopback`](../../util/loopback/README.md)：`/api` Host fence 读 hostname，放行读 socket peer；其他客户端插件消费派生的 `ctx.connection.isLoopback` 状态，而不自行判定。node 半侧的 `/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，以及整个配置面——`settings.describe`/`openDocument`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`；读取与原生操作也在内，因为 describe 会返回已暴露的配置、打开操作会作用于 Host 桌面，而探测任意引用会报出某条凭据来自何处——以及 agent（智能体） preset 的创作面 `agentPreset.read`/`copy`/`openDocument`/`remove`，因为组装指明了一个会话所运行的插件，读取它是侦察，而 copy/remove/openDocument 管理名单并驱动宿主桌面（创作只有复制一种写入，因此这些方法都不接收组装文本或路径）；`agentPreset.list` 与 `agentPreset.select` 不在其中——名单只携带 id 与信任级别，而选择一个 preset 并不比 `session.create` 自带的 `agentPreset` 多给任何能力，何况默认 preset 本就带着 bash；网关的 `pluginInventory/list` 在其中，它是同一种组装读取往上一层，读的是实时 Loader 名单）以空信任表过信任 fence，从而钉在回环——已声明且通过 token 认证的 `trustedHosts` 授权可达其余全部方法，而这些方法仍只限回环本机：配对（pairing）认证的是设备，配置面与原生桌面面还额外要求人在这台机器旁。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## /api 浏览器信任栅栏

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。这道栅栏是可达性策略，而不是认证——认证是下文的配对 token，且非空的 `trustedHosts` 不配 `pairingTokenEnv` 会让加载报错，因为那样的配置放行不了任何请求。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## 配对 token 认证

来自非回环 peer 的请求只有在部署配置了 `pairingTokenEnv` 且请求以 `dsh_auth` cookie 或 `Authorization: Bearer` 请求头出示它所指向的 token 时才被放行（`src/api-auth.ts`）；比较在 sha256 摘要上恒定时间进行。

配置携带引用，而不是机密本身。`pairingTokenEnv` 是一个凭据引用，在加载时经 [`ctx.credentials`](../../credentials/credentials/README.md) 解析一次，因此 token 可以存放在环境变量、受管凭据存储或 `.env` 层中，任何回显配置的表面都无法泄漏它。引用解析不到取值、解析出的 token 不足 16 个 `A-Za-z0-9_-` 字符，以及在没有组合 credentials 服务时指定引用，都会让加载报错。由于解析每次加载只做一次，轮换后的 token 在下次启动生效——放行本身是同步的。

回环判定读取 socket peer 地址（`req.socket.remoteAddress`），绝不读客户端可控的 `Host` 头：在全接口绑定上，任何能到达 socket 的客户端都可以声称 `Host: localhost`，因此基于头的豁免会绕过 token。上文的 Host 栅栏对每个请求仍然运行，但它本身不承担任何认证。

回环的免 token 豁免假定的是同一台机器，而不是同一个用户：任何本地进程无论 uid 都能到达该 socket，因此在多用户宿主上，能访问回环端口就等同于能以本进程身份运行。同样的道理决定了部署要直接绑定网络，而不是置于反向代理之后——代理从回环发起连接，会使每个转发请求都成为回环 peer——也决定了 `X-Forwarded-*` 被忽略：请求头无法确立 peer 究竟是谁。

浏览器经 URL fragment 配对：打开一次 `#auth=<token>` 链接会把 token 存入 localStorage、从地址栏剥去 fragment，并在每次启动把它重新发布为 `SameSite=Strict` cookie（https 上附加 `Secure`），浏览器随后会把它附加到 `/api` fetch 与 WebSocket upgrade 上。以 `authority: 'trusted-host'` 注册的专用通道要求同样的放行；`authority: 'loopback'` 通道与特权端点集即使调用方已认证也仍钉在回环 peer。该集合覆盖 `/api` 通道承载的两种端点形式——API Proxy 的点号形式方法与 Typert 网关的 `namespace/method` 斜杠形式——并且这个钉定施加在每个 `/api` 端点都会经过的那一个点上，位于拦截器与回退之间的抉择之前。只在回退里施加它会让钉定取决于路由顺序，因为被拦截器认领的端点根本不会到达那个回退。

## `/api` WebSocket 下行

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE（Server-Sent Events）回退；`toFetchHandler` 的 SSE 编解码只服务进程内同构载体。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **配对需要链接本身，仅有 token 不够**：从未访问过 `#auth=<token>` URL、直接打开裸权威的浏览器没有任何输入 token 的途径；页面呈现普通的重连状态。token 输入界面是暂缓的客户端 UI 工作。
- **特权方法集即使已认证也留在回环**：为已配对设备解锁配置面是一个有意保留的待决问题，不是疏漏。
