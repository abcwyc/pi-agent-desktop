# Pi Agent 桌面 App

Pi Agent 使用 Tauri 封装本地 Web UI 与 Agent 服务，支持 Apple Silicon Mac、Windows x64 和 Linux x64。由于应用包含本地 API 和 AgentSession，安装包会携带 Next.js standalone 服务与当前平台的 Node.js runtime；打开 App 时服务自动启动，退出 App 时自动停止，无需另开终端或安装 Node.js。

## 要求

- macOS 11 或更新版本（Apple Silicon）、Windows 10/11 x64，或安装了 WebKitGTK 4.1 与 GTK 3 的 Linux x64 发行版
- 构建时需要 Node.js 20.9 或更新版本
- Rust 1.85 或更新版本
- macOS 使用 Xcode Command Line Tools；Windows 使用 Microsoft C++ Build Tools；Linux 使用 GTK/WebKitGTK 开发包

## 开发模式

```bash
npm install
npm run desktop:dev
```

这个命令会启动现有的 Next.js dev server，并用原生窗口打开。它不会生成 standalone 服务或修改日常开发使用的 `.next/`。

## 构建 App 与 DMG

```bash
npm install
npm run desktop:build
```

构建脚本会：

1. 在 `.next-desktop/` 生成隔离的 Next.js standalone build。
2. 将服务端资源与当前平台架构的 Node runtime 暂存给 Tauri。
3. 在 macOS 生成 `.app` 和 `.dmg`，在 Windows x64 生成 NSIS `-setup.exe`，在 Linux x64 生成 `.deb`。

Linux 安装包依赖 WebKitGTK 4.1 和 GTK 3 运行库；Node runtime 已包含在安装包中，用户无需另行安装 Node.js。

默认产物位于：

```text
src-tauri/target/release/bundle/macos/Pi Agent.app
src-tauri/target/release/bundle/dmg/Pi Agent_<version>_<arch>.dmg
src-tauri/target/release/bundle/nsis/Pi Agent_<version>_x64-setup.exe
src-tauri/target/release/bundle/deb/pi-agent-desktop_<version>_amd64.deb
```

构建结果是当前机器架构的原生应用：Apple Silicon 构建 `aarch64` DMG，Linux x64 构建 `.deb`，Windows x64 构建 NSIS `-setup.exe`。正式流水线不构建 Intel Mac 版本。发布给其他用户前，macOS 应使用 Apple Developer ID 签名并公证，Windows 应使用 Authenticode 证书签名；本地开发和测试不要求平台代码签名。

桌面版会检查 `pi-agent-desktop`、Pi 与 Pi Web 的官方 GitHub Release。每个项目最多每 7 天检查一次；发现任一组件有新版后，用户可以从设置中安装包含全部最新组件的完整签名 App 并重启。详细机制见 [桌面升级与发布说明](./desktop-updates.md)。

## 运行日志

内置服务的 stdout/stderr 写入：

```text
~/Library/Logs/com.abcwyc.pi-agent/server.log
```

App 会把登录 shell 的 `PATH` 传给内置服务，以便从 Finder 启动时仍能找到用户通过 Homebrew、nvm、Volta 等方式安装的命令行工具。

## macOS 后端切换

点击应用左上角 Logo，直接选择 **Local · 本地** 或已保存的远端，勾号表示当前连接。选择“管理后端…”可添加名称和 URL、编辑名称或移除未连接的远端；系统菜单 **Settings → Backend Connection…** 也能打开管理窗口。

URL 使用服务器根地址（例如 `https://pi.example.com` 或 `http://192.168.1.10:30141`），不要填写 `/api`、会话路径、账号密码或查询参数。保存相同 URL 会更新名称。切换会重启应用，并停止正在运行的本地任务；切回本地不会删除已保存的远端。

远程模式不启动内置服务器，会话和文件属于远端，本机上传、下载使用网页方式。远端 Logo 可打开应用原生菜单，但远端页面不能读取后端列表、直接切换连接或获取本机桌面权限。没有兼容 Logo 的页面会显示左上角 π 按钮；服务器不可用时也可使用系统菜单返回本地。

连接列表保存在应用配置目录的 `backends.json` 中。首次启动会自动迁移旧版 `backend-url.txt`，保留当前地址并删除旧配置文件。配置损坏时管理窗口提供重置为本地的入口，不影响会话文件。
