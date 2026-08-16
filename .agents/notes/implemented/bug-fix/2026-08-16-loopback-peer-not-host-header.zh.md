# Agent Note: 回环信任取自 socket peer，而非 Host 头

Status: implemented

[English](2026-08-16-loopback-peer-not-host-header.md) | 中文

## 问题

[LAN 配对功能](../feature/2026-08-15-web-lan-pairing-token-tls.md)曾从请求 `Host` 头（`isLoopbackHostname(hostUrl.hostname)`）授予免 token 的回环豁免以及特权方法钉住。这在服务器仅绑定 `127.0.0.1` 时是安全的，因为没有非浏览器客户端能到达 socket。把绑定开到 `0.0.0.0` 后它变成了完整的认证绕过：`Host` 头只有**浏览器**无法伪造，而任何 LAN 设备现在都能用原始客户端到达 socket。发布前评审当场证实——用 `curl` 连到服务器 LAN IP 并带 `-H 'Host: localhost'` 且不带 token，对 `/api` 方法以及钉在回环的特权面（`settings.describe`、`credentials.describe`）都返回 `200`，即向网络上任意设备开放了未认证的 RCE 级访问外加配置/凭据泄露。

## 决定

回环信任类别取自 socket peer 地址，绝不取 `Host` 头。

- `isLoopbackAddress(req.socket.remoteAddress)`（`src/loopback-hostname.ts`）从内核报告的真实连接来源判定回环（`127.0.0.0/8`、`::1`、IPv4 映射 `::ffff:127.x`）；地址缺失时向「需要 token」失败关闭。
- `admitApiRequest` 接收显式的 `peerIsLoopback`，只对回环 peer 授予免 token 类别；非回环 peer 无论声称什么 `Host` 都必须出示 token。Host 栅栏对每个请求仍作为 DNS 重绑定/跨站防御运行——只是不再承担认证。
- 特权方法钉住与 `authority: 'loopback'` RPC 通道要求回环 peer。由于这些检查运行在 Fetch 表示上（没有 socket），node 层把 socket 推导出的事实盖到一个内部请求头上（`stampPeerLoopback` / `requestPeerIsLoopback`，`PEER_LOOPBACK_HEADER`），覆盖任何客户端提供的副本，使 Fetch 侧钉住检查以不可伪造的方式读取。
- 在全部四处强制执行：`/api` 路由、两条 WebSocket upgrade、专用 RPC 通道，以及 Fetch 侧的特权/拦截器钉住。

`adb reverse` 与 SSH 隧道不受影响：它们从 PC 上的 `127.0.0.1` 连入，服务器因此确实看到回环 peer 并保持免 token——文档所述的隧道工作流得以保留。

## 考虑过的替代方案

- **保留基于 Host 的豁免，但让 `0.0.0.0` 绑定即使 Host 为回环也要求 token。** 否决：它把可达性与认证混为一谈，且特权钉住仍信任客户端的头；socket peer 才是真正区分本地与远程的事实。
- **完全去掉回环豁免（始终要求 token）。** 否决：它破坏免 token 的本地使用与隧道（本功能有意保留），相较正确的 peer 检查毫无安全收益。

## 后果

- `api-auth.host.spec.ts` 中编码「回环取自 Host 头」的用例被基于 peer 的用例加一条显式回归替换：非回环 peer 伪造 `Host: 127.0.0.1`/`localhost`/`[::1]` 在 HTTP 路由与 WebSocket upgrade 上均被拒。
- 真实 HTTP 的 node 测试现在断言真正的回环 peer 路径（真实 `127.0.0.1` 连接免 token 被放行，含特权面），以及 Host 栅栏对回环 peer 仍拒绝重绑定/跨站。远程 peer 的拒绝由注入 LAN `remoteAddress` 的手搭测试覆盖，因为可移植的测试无法造出真实的非回环 peer。
- 一并加固：`dsh_auth` cookie 在 https 页面上附加 `Secure`，`web-tls` 材料目录以 `0o700` 创建。
