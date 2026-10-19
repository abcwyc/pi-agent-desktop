# 与桌面上游同步，同时保留本地 UI

## 两条更新来源

- `origin`：自己的 fork，`martin666888/pi-agent-desktop`。定制通过 PR 合入这里的 `main`。
- `upstream`：桌面上游，`abcwyc/pi-agent-desktop`。功能修复和桌面版本从这里合入。
- pi-web / Pi SDK 的组件更新是另一层；现有 `component-updates.yml` 处理的是这一层，
  不代替与桌面上游的同步。它目前需要手动触发，不会自动完成本 fork 的 UI 整合。

不要通过重置 fork 到 upstream 的方式更新，也不要让安装器覆盖自定义版本。
保持 upstream 的提交祖先关系，之后 Git 才能只合并新增的修改。

## 本次整合

2026-10-19 基于桌面 `0.7.4` / `3b6a877`，内置 Pi SDK `1.3.0`。
原有未提交修改完整保存为本地备份分支 `codex/backup-ui-before-sync-20261019`。
PR 分支 `codex/sync-desktop-ui-0.7.4` 从最新远端建立，把备份中的定制通过三方比较
应用在最新代码上，最后提交一个整合 commit；主分支未重写。

保留远端的新聊天空间隔离、项目时间线和分页、附件选择修复、OAuth、安全修复、
平台设置样式和组件拆分。设置菜单、项目菜单、项目切换及会话补全继续使用拆出的
组件，本地样式和键盘导航接到新组件上，不把旧 JSX 整块搬回去。

本地必须保留：

- 中性主题、统一菜单组件、4px 行间距、选中 / 悬停 / 键盘焦点和禁用状态。
- 推理级别与 Config 分别提供入口；Config 保留名称下方的说明和勾选状态。
- 圆形发送按钮与输入框底部圆角同心，换行后仍保持同心，触屏大小同步变化。
- 顶部操作靠近窗口右侧；业务菜单不恢复为系统原生菜单。
- `userHome()` 在运行时解析目录，保留 Windows 文件追踪内存修复。

所有定制样式仍放在 `app/native-theme.css`。`app/globals.css` 和
`app/settings.css` 保持 pi-web 基线。新加入的原生选项框改用 `AppSelect` 或
`AppCombobox`；不要只处理 Git 标出的冲突，新文件同样需要检查。

## 以后每次同步

以下命令用于已提交定制、工作区干净时，在 PowerShell 执行：

```powershell
git fetch --no-tags origin main
git fetch --no-tags upstream main
git switch -c codex/sync-desktop-next origin/main
$syncBase = git merge-base HEAD upstream/main
git log --oneline HEAD..upstream/main
git diff --name-only $syncBase upstream/main
git merge --no-commit upstream/main
```

如有未提交修改，先检查并提交到本地备份分支，包括新组件和测试；不要 `reset --hard`，
不要遗漏未跟踪文件。已有同名同步分支时使用新的分支名。

逐文件处理冲突：保留上游运行时和拆分结构，把定制重接到实际的新入口。尤其检查
`ChatInput`、`AppShell`、侧栏、拆出的菜单、主题、依赖锁和测试。不要批量选 ours / theirs。
依赖升级保留锁定版本，合并 Radix 依赖后运行 `npm install`；Tauri npm / Cargo 的
major/minor 配对由发布测试检查。不要通过重新解析全部 caret 版本解决锁文件冲突。

```powershell
npm ci
npm test -- --test-timeout=60000
npx tsc --noEmit
npm run lint
node scripts/upstream-css-baseline.mjs update 6fcd7d4
npm run drift
node e2e/option-controls.mjs
$env:PI_WEB_DESKTOP_BUILD = '1'
npm run build
Remove-Item Env:PI_WEB_DESKTOP_BUILD
git diff --check
git add --all
git commit
git push -u origin HEAD
gh pr create --repo martin666888/pi-agent-desktop --base main
```

`6fcd7d4` 是当前 pi-web 样式基线，不是桌面版本；只有同时更新 pi-web 时才换成
新的真实 pi-web 引用，不能用桌面上游提交来掩盖样式漂移。生产构建使用隔离的
`.next-desktop`，不会污染开发目录，也不覆盖正在运行的 exe 或资源。
Windows 使用 Node 22.19 以上版本。测试命令使用双引号 glob，避免 cmd 把单引号
当作文件名的一部分而静默执行 0 项测试；并发限制为 4，避免同时启动大量 SDK 测试进程。

最后在 PR 写明测试结果、上游已有或平台特有的失败，以及深浅主题、窄窗口、附件选择、
新聊天模式、菜单和多行输入框的检查结果。自动检查失败时查明原因，不通过跳过测试
或降低边界风险等级来制造通过结果。PR 合并后再把本地主分支快进到 `origin/main`。

完整菜单规范见 [ui-menu-audit.md](ui-menu-audit.md)，既有桌面设计边界见
[ownership-boundaries.md](ownership-boundaries.md) 和 [agents/fork-ui.md](agents/fork-ui.md)。

## 本次验证记录

- Node 22：全部组件、hooks、维护脚本和本次更新相关运行时共 1024 项，1015 项通过，
  9 项按原有条件跳过，0 项失败；新增同步分类 CLI 回归及样式 / tracing 边界检查另外通过。
- TypeScript、lint、隔离 standalone 生产构建、样式基线与 drift 检查通过。
- 真实组件在深浅主题 × 1280 / 390 / 320px 验证菜单行距、选中与悬停、键盘、
  IME、空值、长列表滚动、新 worktree 建议与创建，以及多行输入框同心圆角。
- Windows 全量测试仍不通过，不能声称全量绿灯。对剩余失败涉及的同一组测试，在相同
  Node / 依赖 / 权限下比较干净 `3b6a877` 副本与整合代码：上游 48 项失败，整合后
  26 项失败，整合代码的失败名称均在上游失败集合内。主要为文件符号链接权限、
  SDK / 子进程清理时的 `EBUSY`、Windows 路径及 npm 子进程兼容问题；完整运行另有
  SDK 测试的活跃句柄阻止退出。没有跳过这些测试或放宽生产代码来制造通过结果。
- 原始日志、对照结果和截图位于忽略的 `test-results/`，不会进入提交。Linux 完整测试
  与原生桌面 shell 由 PR 的现有 CI 继续验证，macOS 原生改动未在此 Windows 主机运行。
