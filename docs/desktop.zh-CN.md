# Pi Agent 桌面 App

Pi Agent 使用 Tauri 封装本地 Web UI 与 Agent 服务，支持 Apple Silicon Mac、Windows x64 和 Linux x64。由于应用包含本地 API 和 AgentSession，安装包会携带 Next.js standalone 服务与当前平台的 Node.js runtime；打开 App 时服务自动启动，退出 App 时自动停止，无需另开终端或安装 Node.js。

## 要求

- macOS 11 或更新版本（Apple Silicon）、Windows 10/11 x64，或安装了 WebKitGTK 4.1 与 GTK 3 的 Linux x64 发行版
- 构建时使用 Node.js 22.19 或更新的 22.x 版本，与项目 CI 保持一致
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

桌面构建启用独立 Webpack worker 与内存优化，避免自定义 Webpack 配置关闭默认 worker 后将编译内存集中在主进程。网络环境需要代理时，给构建进程设置 `HTTPS_PROXY`、`HTTP_PROXY`，并通过 `NO_PROXY=localhost,127.0.0.1,::1` 保持本地服务直连；Node 不会自动继承 Windows 系统代理。

Windows 上项目与用户目录位于不同盘符时，不能只依赖 `outputFileTracingRoot` 阻止扫描用户目录。文件访问和路径展示代码都应通过 `lib/user-home.ts` 的 `userHome()` 解析主目录；直接对 `homedir()` 的结果做字符串处理也可能触发 Next 文件追踪器递归扫描。可运行 `node --max-old-space-size=256 --test scripts/home-tracing.test.mjs` 在临时目录中验证这一边界，无需构建应用。worker 与内存优化不能替代此修复。

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
