# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

Web HTTP 与 upgrade route 注册插件（默认导出 `WebServer`，配置为 `{host, port, tlsCertPath, tlsKeyPath}`）：一个在激活时开始监听的 `node:http` 服务器——两个 TLS 路径都配置时为 `node:https`——提供 `ctx.webServer`。`register(route)` 添加具名的 `exact`／`prefix` HTTP route；`registerUpgrade(route)` 添加精确 pathname 的 upgrade route；同一张表内的重复路径会抛错，因为 route 模式是组合层约定，冲突即配置错误；两者返回的 disposer 都会移除注册。`registerFallback(handler)` 注册一个 handler，处理所有未被具名 route 命中的请求。第二次注册会抛错；随附的 SPA dist 服务器 [`dsh-host-frontend-static`](../frontend-static/README.md) 是该 handler 的所有者，没有注册 handler 时服务器返回 404。`tapIndex(transform)` 添加一个 index.html 转换，`applyIndexTaps(html, nonce)` 按注册顺序对一段响应体运行已注册的转换；fallback handler 在每次 index 响应时调用它，并传入该次响应的脚本 nonce。注入可执行 `<script>` 的转换必须把 nonce 带在标签上，否则声明了该 nonce 的 Content-Security-Policy 会拒绝运行注入的代码——[`frontend-static`](../frontend-static/README.md) 是随附的所有者，由它生成 nonce 并发送策略。`port` 读取正在监听的端口（当 `port` 为 0 时读取 OS 分配的值），`host` 读取配置的绑定宿主（这些是其他插件据以自适应的组合期事实，例如 directory-picker 选择器），`scheme` 在配置了 TLS 材料时读取 `'https'`，否则读取 `'http'`（URL 构建方以它为准）。HTTP 匹配顺序固定不变：先在整张表中匹配精确 route，再匹配最长前缀，最后交给 fallback handler。upgrade 只做精确匹配，未命中连接直接关闭；注册顺序不影响请求处理。

该包不了解任何 harness 概念，也不提供任何文件服务：`/api` HTTP 桥接与下行 WebSocket 是 connection 插件的 route，插件 bundle 与 HMR（热模块替换）事件流是 modules／hmr 插件的 route，dist 服务则属于 fallback 持有者。upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request。`host` 只接受 `127.0.0.1`（默认安全姿态）和 `0.0.0.0`（有意向网络开放）。该服务器只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。该包从不打印内容；URL 行属于 shell。

TLS 配置是 PEM 文件路径对 `tlsCertPath`/`tlsKeyPath`——只传路径、绝不内联材料，这样回显配置的表面（清单、诊断）不可能携带私钥；材料的来源是组合应用的事情（[`dsh-web-app/tls`](../../bundle/web-app/README.md) 是随附的生成器）。只配置一半、文件不可读或内容不是密钥/证书 PEM 都会拒绝激活：要求了 TLS 的部署绝不悄悄退回明文服务。两种协议下 route、upgrade、错误兜底与 teardown 语义完全一致。监听失败（EADDRINUSE……）会从激活过程抛出，并以绑定诊断信息拒绝 Loader 组合；失败的候选 fiber 会被 dispose（资源释放）。处理 HTTP 请求时抛错（例如 fallback 持有者的 `decodeURIComponent` 收到格式错误的百分号转义，或客户端在请求体传输中途断开）时，服务器会响应 400；若响应头已经发出，则销毁 socket，并记录 warning，但绝不会退出进程。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket，并仅在 HTTP server 与这些 socket 均已关闭后返回。

## 模型体验

无。该包只是浏览器与其他插件所注册 HTTP／upgrade route 之间的 Web 载体，其中没有任何内容会进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **不提供认证或来源策略**：该服务器只承载 route；放行（`/api` 信任栅栏与配对 token）属于注册这些 route 的插件，因此非回环绑定会把所有没有这类所有者的 route 公开给对应网络。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。
