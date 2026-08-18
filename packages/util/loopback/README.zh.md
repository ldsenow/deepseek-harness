# dsh-loopback

[English](README.md) | 中文

零依赖的回环判定：两个纯谓词，没有 `ctx`、没有状态、没有事件。浏览器安全，因此同一套规则既能回答页面自身的位置，也能回答 Node 的 socket。

## API

```ts
import { isLoopbackAddress, isLoopbackHostname } from '@deepseek-ai/dsh-loopback'
```

| 导出 | 角色 |
|---|---|
| `isLoopbackHostname(hostname)` | 一个 WHATWG URL hostname 是否指向回环权威：`localhost`、`[::1]`，或 IPv4 `127.0.0.0/8`。 |
| `isLoopbackAddress(address)` | 一个 socket peer 地址（`req.socket.remoteAddress`）是否位于回环接口：IPv4 `127.0.0.0/8`、`::1`，或 IPv4 映射的 `::ffff:127.x.x.x`。`undefined` 不算回环。 |

## 两者不可互换

hostname 是客户端**声称**的；socket peer 地址是内核**观察到**的。在全接口绑定上，任何能到达 socket 的客户端都可以发送 `Host: localhost`，因此一条路由在判断调用方是否本地时必须读 `isLoopbackAddress`：从 hostname 推导这个判断，等于把豁免交给任何愿意发送该请求头的调用方，这也是[配对 token 放行](../../client/connection/README.md)读取 peer 的原因。`isLoopbackHostname` 回答的是另一个问题：一个 URL 指向哪个权威，供 DNS 重绑定栅栏与页面描述自身位置使用。

两者都向拒绝一侧失败。谓词不认识的地址——不常见的字面量形式、非 IP 传输、`undefined`——都不算回环，因此调用方仍需满足该路由要求的认证，而不会因解析上的缺口被豁免。

## 消费者

[`dsh-client-connection`](../../client/connection/README.md) 两者都用：`/api` Host 栅栏与浏览器半侧的 `ctx.connection.isLoopback` 读 hostname，而 token 放行与特权端点钉定读 socket peer。[`dsh-client-hmr`](../../client/hmr/README.md) 把它的 `/plugins/events` 重载通道限制在回环 peer。

## 模型体验

无，因为这些谓词只为一条路由的放行判断对网络地址做分类，它们的任何结果都不会进入提示词、工具 schema 或工具结果。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **只支持规范的点分四段 IPv4**：`127.1`、`2130706433` 以及 `127.0.0.01` 这类补零八位组都会被判为非回环。当前没有消费者会产生这些写法：Node 报告的 peer 地址是规范形式，而 `/api` 栅栏用 WHATWG `URL` 解析 `Host`，会在谓词运行前把每一种简写、补零与整数形式都改写成 `127.0.0.1`。这个偏向始终是要求认证，绝不会是给出豁免。
- **不处理 IPv6 zone index**：带作用域的 `::1%lo0` 不被识别。失败方向相同，且没有观察到哪个 peer 地址携带 zone。
