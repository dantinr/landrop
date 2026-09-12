# 邻传

一个局域网共享页面：桌面端提供公共 WebSocket 聊天室、文件拖拽上传、局域网实时上传状态和文件下载；移动端提供精简的纯聊天界面。

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

## 文件位置

- 上传文件：`data/files/`
- 文件索引：`data/files.json`
- 聊天记录：`data/messages.json`

同名文件会分别保存，不会覆盖。上传中断产生的临时文件会在下次启动时自动清理。

## 改端口

```powershell
npm start -- --port=9000
```

这个版本没有账号、口令和权限控制，请仅在可信的家庭局域网中运行。停止终端中的服务后，页面也会停止访问。

## 版本与许可

当前版本以 [VERSION](VERSION) 为准，并同步记录在 npm 包元数据中。版本格式为 `x.x.xx`，末段从 `10` 开始、到 `99` 后向前进位并重置为 `10`，例如 `0.0.99` 的下一版本是 `0.1.10`。

邻传默认采用 [Apache License 2.0](LICENSE)。第三方组件及其许可证见 [THIRD_PARTY](THIRD_PARTY)。
