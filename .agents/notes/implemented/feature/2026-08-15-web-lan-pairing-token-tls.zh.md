# Agent Note: LAN 服务将配对 token 与自签名 TLS 结合

Status: implemented

[English](2026-08-15-web-lan-pairing-token-tls.md) | 中文

## 问题

Web GUI 的 `/api` 表面以宿主进程身份执行代码，因此 `dsh --profile web` 曾直接拒绝 `--host 0.0.0.0`：[浏览器信任栅栏](../architecture/2026-07-28-api-browser-trust-boundary.md)是混淆代理防御而非认证，未认证的 LAN 绑定等于把远程代码执行交给网络。这一拒绝同时挡住了它本要保护的正当部署：在所有者自己的网络上从另一台设备（手机浏览器、PWA 安装、WebView 包装应用）输入 PC 的 `ip:port` 使用 GUI。

## 决定

认证是部署配置的**配对 token**，在栅栏已经所在之处强制执行（`dsh-client-connection` 的 `src/api-auth.ts`），LAN 服务再由 Web 组合包持有的**自签名 TLS** 包住：

- **放行**：信任栅栏先把请求分类（`src/api-request-trust.ts` 中的 `refused | loopback | trusted-host`），`trusted-host` 请求只有在配置了 `pairingToken` 且请求出示了它时才被放行——以 `dsh_auth` cookie 或 `Authorization: Bearer` 出示；比较在 sha256 摘要上恒定时间进行。回环保持免 token：本机进程本就拥有这台机器，隧道工作流（`adb reverse`、SSH）继续免认证可用。专用 `trusted-host` RPC 通道走同一道放行；`loopback` 权威通道与特权方法集即使调用方已认证也仍钉在回环——配对认证的是设备，配置面还额外要求人在机器旁。
- **配对**：打印的 LAN 行就是配对 URL `https://<lan-ip>:<port>/#auth=<token>`（Jupyter 的模式）。浏览器半侧（`src/client/auth.ts`）把 fragment 收进 localStorage、从地址栏剥去，并在每次启动把它重新发布为 `SameSite=Strict` cookie，浏览器随后会把它附加到 fetch 与 WebSocket upgrade 上——不需要任何载体改动，fragment 也永远不会到达服务器或日志。
- **组合期报错**：token 不匹配 `[A-Za-z0-9_-]{16,}`，或非空 `trustedHosts` 不配 token，都会让插件加载失败；CLI 上 `--host 0.0.0.0` 与 `--trusted-host` 不带 `--pairing-token` 是用法错误。
- **TLS**：`dsh-host-webserver` 增加 `tlsCertPath`/`tlsKeyPath`（只传路径、绝不内联材料，回显配置的表面无法泄漏私钥），两者都设置时以 `node:https` 服务。`dsh-web-app/tls` 提供方在首次全接口启动时于 `dshHomePath('web-tls')` 下生成持久的自签名证书对——SAN 携带回环名加采样的 LAN 地址、十年有效期、密钥文件仅属主可读——设备一次性接受的例外因此在重启后仍然有效。回环绑定保持明文 HTTP。

## 考虑过的替代方案

- **只有 token、没有 TLS。** 否决：在共享 Wi-Fi 上 token cookie 与全部会话内容都会明文传输；能认证但可被嗅探的信道不是部署要求的「安全信道」。代价是手机上一次性的自签名证书警告，且它被吸收进同一次配对链接访问里。
- **只用 cookie 或只用请求头出示。** 否决：浏览器无法在 WebSocket upgrade 上设置请求头（需要 cookie），非浏览器客户端也不该被迫使用 cookie（需要 Bearer）。两种形式喂给同一个校验器。
- **经启动 manifest 把 token 发给浏览器。** 直接否决：SPA 及其注入的启动 manifest 是免认证服务的，其中的任何内容对网络而言定义上就是公开的。fragment 链接让秘密不出现在任何被服务的字节里。
- **为已认证设备解锁特权／配置面。** 暂缓而非已决：这个钉住的理由（设置、凭据、原生桌面操作）关乎本地在场，放松它值得单独一个决定。
- **双协议嗅探，让输入的 `http://ip:port` 重定向。** v1 否决：为了配对链接本已避免的、只在首次访问出现的小麻烦，在同一端口上窥探每个 socket 的首字节来复用 HTTP 与 TLS 是实打实的载体复杂度。

## 后果

- `dsh --profile web --host 0.0.0.0 --pairing-token <token>` 是受支持的 LAN 部署；先前的硬拒绝已经移除，信任边界注记中暂缓的认证事项在本注记落地。
- 早于本决定的 `trustedHosts` 组合在补上 `pairingToken` 之前不再放行任何人——在加载期报错，而不是以沉默的 403 被发现。
- 从未访问过配对链接、直接打开裸权威的设备暂时没有 token 输入界面；它会看到普通的重连状态（在 connection README 中记录为暂缓的客户端 UI 工作）。
- 既有证书 SAN 里固化的 LAN IP 会随网络变化漂移；服务照常工作，只有浏览器警告会重新出现，因为放行从不依赖证书。
