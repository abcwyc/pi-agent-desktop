# Pi Agent v0.1

Pi Agent v0.1 是首个 macOS 预览版本。

它将 [pi](https://github.com/earendil-works/pi) 的 Agent 能力与 [pi-web](https://github.com/agegr/pi-web) 的 Web 交互界面封装为一个可独立安装的桌面 App，并由 [pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) 提供 macOS 集成、产品品牌、设置和版本升级能力。

> 设置界面显示版本 `0.1`，内部语义化版本为 `0.1.0`。

## ✨ 首版亮点

- **独立 macOS App**：内置 Next.js 服务、Node.js runtime 和 Pi SDK，无需单独启动 Web Server。
- **统一 Pi Agent 品牌**：Finder、Dock、窗口标题和安装包均使用 `Pi Agent` 名称，并使用专属 App 图标。
- **完整 Agent 工作区**：支持历史会话、实时聊天、工具调用、上下文与成本查看、会话分支和 Fork。
- **项目文件浏览**：可以浏览项目文件、切换 Git worktree，并预览源码、Diff、Markdown、图片、音频、PDF 和 DOCX。
- **模型与扩展配置**：支持模型管理、OAuth/API Key、自定义模型、Skills 和 Plugins。
- **版本设置页**：通过齿轮入口查看 `pi-agent-desktop`、`pi` 和 `pi-web` 的项目署名、当前打包版本及 GitHub Release 版本。
- **每周更新提醒**：最多每七天检查一次三个组成项目的最新稳定 Release。
- **统一整包升级**：任意组件有新版时，通过一个升级入口安装包含全部最新版组件的完整签名 App，避免局部替换依赖导致兼容性问题。

## 📦 内置组件

| 组件 | 版本 | 项目地址 |
| --- | --- | --- |
| `pi-agent-desktop` | `0.1.0` | [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) |
| `pi` | `0.81.1` | [earendil-works/pi](https://github.com/earendil-works/pi) |
| `pi-web` | `0.7.17` | [agegr/pi-web](https://github.com/agegr/pi-web) |

## 🛠️ 修复与体验改进

- 修复内置 Node Helper 在 Dock 中显示额外 `exec` 图标的问题。
- 将页面中的 `Pi Web` 产品名称固定替换为 `Pi Agent`，后续同步 `pi-web` 时继续保留本地品牌层。
- 移除聊天输入区域原有的 Web/Pi 版本号展示，减少界面干扰。
- App 图标替换为 Pi Agent 专属图标。
- App Bundle Identifier 更新为 `com.abcwyc.pi-agent`。
- 适配 Pi `0.81.1` 的 `streamFn` 接口变化，保持会话自动命名正常工作。

## 💻 安装方式

1. 从本 Release 的 Assets 下载适合当前 Mac 架构的 DMG。
2. 打开 DMG，将 `Pi Agent.app` 拖入 `Applications`。
3. 从“应用程序”启动 Pi Agent。

系统要求：**macOS 11 或更高版本**。

当前已构建的本地测试产物为 Apple Silicon（arm64）版本；Intel 用户应下载由正式 Release 流水线生成的 `x86_64` 版本。

### 是否需要单独安装 Pi？

不需要。Pi Agent App 已包含桌面功能运行所需的 Pi SDK。

但安装 App 不会在系统全局安装 `pi` 命令。如果需要在终端中使用 Pi CLI，请按照 [pi 项目说明](https://github.com/earendil-works/pi) 单独安装。

如果电脑上已经使用过 Pi，App 会继续读取 `~/.pi/agent` 中原有的会话、模型和认证配置。

## 🔄 关于后续升级

v0.1 是自动升级能力的基线版本，因此旧测试包需要先手动安装由正式 Release 流水线生成并签名的本版本。完成首次安装后，后续版本可以在设置中检查并安装完整的 Pi Agent 更新。

只有包含所需组件的签名 `pi-agent-desktop` Release 已发布时，App 才会执行安装；不会下载未签名文件，也不会直接覆盖已安装 App 内的单个依赖。

## ⚠️ 已知限制

- 当前仅支持 macOS。
- 自动升级依赖正式 Release 中的 Tauri updater 签名和 `latest.json`。
- 面向外部用户公开分发的安装包应使用 Apple Developer ID 签名并完成 notarization；未经公证的开发构建可能被 macOS Gatekeeper 拦截。

## 🙏 致谢

感谢以下开源项目及其贡献者：

- [earendil-works/pi](https://github.com/earendil-works/pi)
- [agegr/pi-web](https://github.com/agegr/pi-web)
- [Tauri](https://tauri.app/)

Pi Agent 的桌面集成由 `pi-agent-desktop` 提供。各组成项目继续遵循各自仓库中的开源许可证。
