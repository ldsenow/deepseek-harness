# 使用 Web UI

[English](index.md) | 中文

先按照[根 README](../../../README.md#run)启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把调用目录作为默认文件系统位置，但新的 Web UI 在添加工作区前不会选中任何工作区。

## 配置模型

打开**设置 → 模型**，输入 DeepSeek API 密钥并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择工作区

点击**选择工作区**，添加启动 `dsh` 时所在的项目目录，然后选中它。选中工作区前，会话输入框不可用。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

agent 可以读取和编辑工作区文件、运行命令、委派工作并维护计划。当操作在当前权限策略下需要审批时，Web UI 会先询问你。

## 远程访问（局域网）

默认情况下服务器绑定 `127.0.0.1`，只能从宿主机访问。若要从网络上的另一台设备访问 Web UI，请绑定所有网络接口并设置配对 token：

```sh
dsh web --host 0.0.0.0 --pairing-token "$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
```

`/api` 表面以 `dsh` 进程身份执行命令，因此 `--host 0.0.0.0` 需要 `--pairing-token`（至少 16 个 `A-Za-z0-9_-` 字符）；不带它启动会报错。在全接口绑定上，服务器还会用一份一次性生成、重启后复用的自签名证书提供 HTTPS。

启动行会打印配对 URL：

```
dsh web: https://127.0.0.1:3080 (LAN: https://192.168.1.5:3080/#auth=<token>)
```

在另一台设备上打开 `LAN:` 链接一次。其浏览器会显示一次性证书警告（证书是自签名的）——接受它；页面随后会存下 URL fragment 中的 token 并从地址栏剥去。首次访问之后，直接输入裸地址 `https://<lan-ip>:3080` 即可重连。从未打开过配对链接的设备无法认证，会停留在重连界面。

回环使用与端口转发隧道保持免 token：`adb reverse tcp:3080 tcp:3080`（USB 或无线调试）或 SSH 隧道让手机经由 `127.0.0.1` 到达 PC，既不需要 token，也不需要接受证书。

加上 `--keep-awake` 可在服务器运行期间持有操作系统的睡眠抑制器，使空闲睡眠不会中断会话或已配对设备；它只抑制空闲睡眠——合上笔记本盖子仍会让机器睡眠。

已配对的远程设备可以创建会话并运行 agent，但配置面（设置、凭据、原生对话框）仍只在宿主机本机可用。流量经过认证与加密，但证书是自签名的——请在你信任的网络上使用，或在外出访问时用 Tailscale 等 VPN 打底。

## 继续使用

- [配置模型](./providers.md)
- [使用 Python SDK](./python-sdk.md)
- [使用其他 CLI 模式](../../../apps/cli/README.md)
- [开发插件](../develop/basic/)
