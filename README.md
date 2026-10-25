# 邻传

一个局域网共享页面：桌面端提供公共 WebSocket 聊天室、文件拖拽上传、局域网实时上传状态和文件下载；移动端提供聊天、图片上传及图片消息下载。

## 启动

需要 Node.js 20 或更高版本。

```powershell
cd D:\codex_projects\LanDrop
npm install
npm start
```

也可以直接双击 `start.cmd`。启动后终端会列出本机地址和可供其他设备访问的局域网地址，例如：

```text
http://192.168.0.10:8787
```

第一次启动时，如果 Windows 防火墙询问是否允许 Node.js 访问网络，请只勾选“专用网络”。其他电脑连接同一个路由器后，在浏览器中打开上面的地址即可。

## 上线提示

设备进入聊天室后，聊天区会显示 `用户名[IP] 上线了`。修改昵称或同一设备新增标签页不会重复提示；设备所有连接断开后重新进入会再次提示。上线提示仅实时显示，不保存到聊天历史。

## 手机上传图片

在手机浏览器打开页面，连接成功后点击聊天输入框左侧的图片按钮，从相册选择一张或多张图片即可上传。输入栏上方会显示进度、取消按钮和上传结果；上传完成的图片会以文件卡片显示在聊天中，可点击下载。非图片文件消息和桌面文件面板在手机上隐藏。

## 文件位置

- 上传文件：`data/uploads/`（物理文件名为 `原文件名[IP].扩展名`）
- 上传中的临时文件：`data/incoming/`
- 文件索引：`data/files.json`
- 聊天记录：`data/messages.json`

例如 `家庭资料.txt` 从 `192.168.1.23` 上传后保存为 `家庭资料[192.168.1.23].txt`。同名文件会追加 ` (2)`、` (3)` 等编号，不会覆盖。上传中断产生的临时文件会在下次启动时自动清理；旧版本已保存在 `data/files/` 中的文件仍可正常下载。

## 改端口

```powershell
npm start -- --port=9000
```

这个版本没有账号、口令和权限控制，请仅在可信的家庭局域网中运行。停止终端中的服务后，页面也会停止访问。

## Nginx 反向代理

`chat.local.conf` 用于本地 `chat.local`；`icloud.aicsi.cn.conf` 是云端域名的独立站点配置，保存在服务器 `/var/www/landrop/icloud.aicsi.cn.conf`，由 `/etc/nginx/conf.d/icloud.aicsi.cn.conf` 符号链接加载。

云端配置将 HTTP 自动跳转到 HTTPS，反向代理到服务器本机 `127.0.0.1:8787`，支持 WebSocket 聊天和流式上传下载，不限制上传大小。需要先启动 LanDrop 后端，并为 `icloud.aicsi.cn` 签发证书，证书路径为 `/etc/letsencrypt/live/icloud.aicsi.cn/`。HTTP 的 `/.well-known/acme-challenge/` 目录映射到 `/var/www/letsencrypt`，供 Certbot webroot 验证和续期使用。

云端站点通过 `X-Robots-Tag: noindex, nofollow, noarchive` 响应头和禁止抓取所有路径的 `/robots.txt` 告知搜索引擎不要索引。

修改配置后，运行 `nginx -t` 验证，再运行 `nginx -s reload` 平滑加载。当前配置使用 `http2 on`，需要 Nginx 1.25.1 或更高版本。

云端服务通过 `LANDROP_TRUST_PROXY=loopback` 读取本机 Nginx 覆盖设置的 `X-Real-IP`，聊天、在线成员及上传文件名使用同一套 IP 解析规则。默认直连模式忽略代理标头；启用后仍只接受来自回环地址的代理，并校验 IP 格式。公网访问显示访问者的公网出口 IP，同一网络下的设备可能显示相同地址；历史记录中的 IP 保留原值。

## Linux 云端服务

`deploy/landrop.service` 用于 systemd 后台运行和开机启动：程序集中放在 `/var/www/landrop`，目录结构与本地一致，以 `landrop` 系统用户运行，仅监听 `127.0.0.1:8787`，由 Nginx 提供外部访问。服务器需安装 Node.js 20 或更高版本，并准备好生产依赖。

上传文件和聊天记录统一保存在项目内的 `data/`：上传文件为 `/var/www/landrop/data/uploads/`，文件索引和聊天记录分别为 `data/files.json`、`data/messages.json`。`data/` 及其内容归 `landrop` 用户所有，更新程序时保留该目录。

`/etc/systemd/system/landrop.service` 符号链接到项目内的 `/var/www/landrop/deploy/landrop.service`。创建链接后，执行 `systemctl daemon-reload` 和 `systemctl enable --now landrop`；使用 `systemctl status landrop` 查看状态，`journalctl -u landrop -f` 查看日志。

## 版本与许可

当前版本以 [VERSION](VERSION) 为准，并同步记录在 npm 包元数据中。版本格式为 `x.x.xx`，末段从 `10` 开始、到 `99` 后向前进位并重置为 `10`，例如 `0.0.99` 的下一版本是 `0.1.10`。

邻传默认采用 [Apache License 2.0](LICENSE)。第三方组件及其许可证见 [THIRD_PARTY](THIRD_PARTY)。
