# `@deepseek-ai/dsh-host-frontend-static`

[English](README.md) | 中文

Web 壳的 SPA dist 服务器：一个函数插件（配置为 `{distIndex}`），占据 [webserver](../webserver/README.md) 的唯一回退席位，并按壳层锁定的语义服务已构建的前端目录——越出 dist 根目录的遍历返回 403，任何未命中项都以 HTTP 200 回退到 `index.html`（SPA 路由），未知扩展名按 `application/octet-stream` 提供，GET／HEAD 之外的方法在没有匹配的具名路由时返回 405。包含性检查做两次：先对拼接后的路径做词法检查，再对文件系统解析出的真实路径检查，因此 dist 内指向外部的符号链接返回 403，而不是变成任意文件读取——网络绑定会把这个席位服务给所有人，前面没有任何 token。停留在 dist 内的链接照常服务。`distIndex` 在加载时一次性解析其链接，这也让缺失的 dist 在加载时报错，而不是在第一个请求时。

## 文档的安全响应头

浏览器的 origin 策略在本包设置，因为服务该文档的正是本包。每个 index 响应都会生成一个新的脚本 nonce，把它传给 `applyIndexTaps` 以便各转换给自己注入的脚本盖上它，并发送声明该 nonce 的 Content-Security-Policy；所有静态响应还携带 `X-Content-Type-Options: nosniff`，文档另外携带 `Referrer-Policy: no-referrer`。

这里的策略比在普通应用中更重要。页面持有配对 token，而在宿主机上它自身就是回环 peer，因此在此 origin 中执行的脚本可以触及已配对远程设备被拒绝的配置面。Harness 还按设计把第三方客户端插件组合包服务进这个 origin，所以「这里只跑我们自己的代码」是策略需要明确声明、而不是想当然的性质。`script-src` 为 `'self'` 加上每次响应的 nonce，只放行 dist 组合包与注入的启动脚本；它还刻意携带 `'unsafe-eval'`，因为客户端代码运行器用 `new Function` 求值模型编写的代码，而那正是产品能力。`style-src` 允许 inline，因为 shiki 与 KaTeX 会输出 nonce 无法覆盖的 `style` 属性；`img-src` 允许远程 http(s) 以渲染 markdown 图片，并允许 `data:`／`blob:` 以承载客户端自行构造的附件；`connect-src 'self'` 把 fetch 与 WebSocket 下行都限制在本 origin。`object-src`、`base-uri`、`frame-ancestors` 与 `form-action` 全部关闭。每个 index 响应都会经过 webserver 已注册的 index 转换器（`applyIndexTaps`），启动 manifest（元数据清单）就是经这条路径送达页面的。`distIndex` 是组合应用的组装事实：[`dsh-web-app`](../../bundle/web-app/README.md) 通过前端包的 exports 解析它并挂载本插件；部署绝不硬编码它。

回退席位只有单一所有者（第二次占据会抛错），并受 effect 作用域约束：dispose（资源释放）插件的 fiber 会释放席位，此后无人占据的 webserver 回答 404。

## 模型体验

无。该包只服务浏览器资产；其中没有任何内容会进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **初始 MIME 表很精简**：它覆盖 Vite 输出的资产集合及实际交付的 PWA manifest；其他扩展名在相应资产类别实际发布前都会回退到 `application/octet-stream`。
