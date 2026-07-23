# Pi Agent

`pi-agent-desktop` 是一个面向 macOS 的本地 AI Agent 桌面应用。它将 [pi](https://github.com/earendil-works/pi) 的 Agent 能力、[pi-web](https://github.com/agegr/pi-web) 的 Web 界面与本仓库的桌面封装、品牌和升级逻辑组合为一个可独立安装的 App，产品界面统一使用 **Pi Agent** 名称。

项目仓库：[abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) · [Releases](https://github.com/abcwyc/pi-agent-desktop/releases)

## 项目组成

Pi Agent 由三个开源项目共同组成：

| 组件 | 仓库 | 在 App 中的职责 |
| --- | --- | --- |
| `pi-agent-desktop` | [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) | macOS 桌面封装、Pi Agent 品牌、设置界面、版本管理和整包升级 |
| `pi` | [earendil-works/pi](https://github.com/earendil-works/pi) | AgentSession、模型调用、工具执行、会话与配置能力 |
| `pi-web` | [agegr/pi-web](https://github.com/agegr/pi-web) | Web UI、会话浏览、聊天交互、模型、Skills、Plugins 和文件预览 |

每次发布所包含的精确版本记录在 [`src-tauri/resources/component-versions.json`](./src-tauri/resources/component-versions.json) 中，也可以在 App 的设置弹窗中查看当前打包版本和对应的 GitHub Release 版本。

## 主要功能

- 按项目浏览和继续历史 Pi 会话，无需查找终端历史或 `.jsonl` 文件。
- 在桌面窗口中与 Agent 实时对话，查看思考、工具调用、上下文用量、成本和压缩状态。
- 从历史消息继续分支，或将会话 Fork 为独立会话。
- 管理模型、OAuth/API Key、自定义模型配置、Skills 和 Plugins。
- 在侧边栏切换 Git worktree，并浏览项目文件。
- 预览源码、Diff、Markdown、图片、音频、PDF 和 DOCX 等文件。
- 支持深色模式、会话自动命名、完成提示音和运行状态恢复。
- 每周检查三个组成项目的稳定 GitHub Release，并在发现更新时提醒用户。
- 通过一个升级按钮安装完整、签名的 Pi Agent 新版本并自动重启。

## 安装与使用

### 安装 macOS App

发布版本可从 [GitHub Releases](https://github.com/abcwyc/pi-agent-desktop/releases) 下载：

1. 根据 Mac 架构下载 Apple Silicon 或 Intel 版本的 `.dmg`。
2. 打开 DMG，将 App 拖入 `Applications`。
3. 从“应用程序”启动，界面产品名称为 Pi Agent。

App 支持 macOS 11 或更高版本。桌面包内包含运行 Pi Agent 所需的 Next.js 服务、Node.js runtime 和当前版本的 Pi SDK，打开 App 时会自动启动本地服务，不需要用户另开终端或单独启动 Web Server。

> 安装 Pi Agent 后，可以直接使用 App 中的 Pi Agent 功能；但它不会在系统全局安装 `pi` 命令。如果还需要在终端中使用 Pi CLI，请按照 [pi 项目](https://github.com/earendil-works/pi) 的说明单独安装。

首次启用签名自动升级前，旧的无 updater 版本需要手动安装一次新的签名 App。此后即可在设置中完成升级。

### 使用现有 Pi 数据

Pi Agent 默认读取 Pi 的本地数据目录：

```text
~/.pi/agent/
```

其中会话通常保存在：

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

如果电脑上已经使用过 Pi，安装 App 后可以继续浏览原有会话、模型和认证配置。可以通过 `PI_CODING_AGENT_DIR` 指向其他 Pi Agent 数据目录。

模型密钥和会话数据保留在用户电脑上；文件浏览 API 仅允许访问当前会话、所选项目和显式授权的工作目录。

## 版本检查与升级

Pi Agent 最多每七天检查一次以下仓库的最新稳定 Release：

- `abcwyc/pi-agent-desktop`
- `earendil-works/pi`
- `agegr/pi-web`

版本与升级规则如下：

1. `pi-agent-desktop` 一旦存在 Release，就以最新稳定 Release 作为可升级版本来源。
2. 三个组件中任意一个版本落后，设置中的统一升级按钮都会启用。
3. 如果多个组件需要更新，发布自动化按 `pi → pi-web → pi-agent-desktop` 的顺序同步和验证。
4. 用户侧不会修改已安装 App 内的单个 JavaScript 包，而是下载一个同时包含三个最新版组件的完整签名 App。
5. 安装完成后 App 自动重启，使三个组件一次性进入同一个经过验证的发布状态。

这种方式可以保持 macOS App 的代码签名和组件一致性，也能避免独立替换 `pi` 或 `pi-web` 导致运行时不兼容。

如果上游新版已经被检测到，但包含该版本的签名 `pi-agent-desktop` Release 尚未发布，设置页会提示暂时没有可安装的签名整包；App 不会退回到下载未签名文件或局部覆盖依赖。

更完整的同步、签名和 Release 配置见 [桌面升级与发布说明](./docs/desktop-updates.md)。

## 本地开发

### 环境要求

- macOS 11+
- Node.js 22（推荐）
- npm
- Rust 1.85+
- Xcode Command Line Tools

### 启动 Web 开发服务器

```bash
npm install
npm run dev
```

开发服务器运行在 [http://localhost:30141](http://localhost:30141)。

日常开发期间不要运行 `next build` 或 `npm run build`。这些命令会写入 `.next/`，可能干扰正在运行的开发服务器；正式构建由桌面准备脚本或 CI 完成。

### 启动桌面开发模式

```bash
npm run desktop:dev
```

该命令会启动现有 Next.js 开发服务器，并使用 Tauri 原生窗口打开页面，不生成安装包。

### 常用检查

```bash
# Node 测试
node --test lib/*.test.mjs scripts/*.test.mjs

# TypeScript
node_modules/.bin/tsc --noEmit

# ESLint 与品牌保护测试
npm run lint

# Rust/Tauri
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# 检查打包组件是否与最新稳定 Release 一致
npm run release:verify
```

`release:verify` 会访问 GitHub，并要求内置的 `pi`、`pi-web` 精确匹配各自最新稳定 Release，同时检查组件清单是否与实际依赖一致。

## macOS 打包

```bash
npm run desktop:build
```

桌面构建流程会：

1. 在隔离目录中生成 Next.js standalone 服务。
2. 打包当前架构的 Node.js runtime。
3. 将服务和运行时作为 Tauri Resources 放入 App。
4. 生成 `.app`、`.dmg` 和用于自动升级的 `.app.tar.gz` 签名产物。

本地构建默认不注册生产 updater，不能接受正式更新。正式 Release 必须通过 GitHub Actions 注入 updater 公钥，并使用对应私钥签名。

## 上游同步与 Release

仓库包含两条自动化工作流：

- [`component-updates.yml`](./.github/workflows/component-updates.yml)：每周一检查 `pi` 和 `pi-web` 的稳定 Release；发现新版后更新依赖、合并 `pi-web` Release Tag、更新组件清单、运行检查，并创建或刷新 `codex/component-updates` PR。
- [`release.yml`](./.github/workflows/release.yml)：组件同步 PR 合并并修改 App 版本后，串行构建 Apple Silicon 和 Intel 产物。Release 在两个架构、签名文件、`latest.json` 和组件清单全部上传完成前保持草稿状态。

上游同步使用 Git 合并，因此本仓库维护的 Pi Agent 品牌、设置入口和升级逻辑会作为本地修改保留。如果上游与本地修改发生冲突，工作流会停止，必须审核和解决冲突后才能发布。

正式发布前需要配置：

- Tauri updater 公私钥；
- GitHub Actions 创建 Pull Request 的权限；
- 面向外部用户分发时所需的 Apple Developer ID 签名和公证。

## 项目结构

```text
app/
  api/                  Next.js API：Agent、会话、模型、文件和更新检查
components/             页面、聊天、侧边栏、设置和版本提醒
hooks/                  会话流、音频、拖放、主题等客户端状态
lib/                    AgentSession、会话读取、文件安全和升级逻辑
scripts/                桌面打包、组件版本同步和 Release 校验脚本
src-tauri/
  capabilities/         Tauri 权限配置
  resources/            桌面资源与组件版本清单
  src/                   macOS 窗口、本地服务和 updater 注册
.github/workflows/      每周组件同步与签名 Release 自动化
```

## 相关文档

- [桌面升级与发布说明](./docs/desktop-updates.md)
- [Git Worktree 使用说明](./docs/worktrees.zh-CN.md)
- [Pi Session 与项目架构说明](./AGENTS.md)

## 署名与许可证

Pi Agent 的桌面集成由 `pi-agent-desktop` 提供，核心能力和 Web 界面分别来自 [earendil-works/pi](https://github.com/earendil-works/pi) 与 [agegr/pi-web](https://github.com/agegr/pi-web)。感谢这些项目及其贡献者。

本仓库根目录代码遵循 [`LICENSE`](./LICENSE) 中的 MIT License。三个组成项目的代码和依赖同时受各自仓库许可证约束；复制、修改或重新分发时请保留相应版权与许可声明。
