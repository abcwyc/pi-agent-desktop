# 业务选项菜单统一规范与检查记录

## Scope and Coverage

本项目的明确用户要求：**同类选项框的 UI 风格统一是铁律。** 本次按完整菜单范围检查，
包括桌面菜单、表单选择、项目与 worktree 选择、分支弹层，以及输入历史、命令、文件、会话补全。
保留现有 Next.js / React、主题、字体和桌面外壳；所有外观定义仍在 `app/native-theme.css`。
项目规则来源为 `AGENTS.md`、`docs/native-theme.md` 和 `docs/ownership-boundaries.md`。

这是业务选项组件检查，不是整个软件所有页面的完整可访问性认证。系统文件/目录对话框属于
独立的系统任务；侧面板中的普通文件列表和 diff 列表不是弹出菜单，不强行套用浮层布局。

| 领域 | 检查依据与证据 | 结果 |
| --- | --- | --- |
| Accessibility | Radix Select、可编辑建议、实际 MCP 选项；方向键、Home/End、搜索、空值、禁用项、Escape、中文 IME、焦点返回 | 已验证共享组件交互；实际设置弹层验证 Escape 不关闭父窗口 |
| Layout | 1280 / 390 / 320px、100 项列表、窗口边界、项目/分支/输入补全入口清单 | 新选择器与实际设置弹层不越界；长列表可滚动 |
| Writing | 保留原有技术选项名、继承/默认值、MCP 说明和已有翻译，新增 API 选择器可访问名称 | 没有更改选项含义或保存值 |
| Typography | 原有字体与 `--fs-small`、`--fs-caption`；长标签、名称与说明、窄屏截图 | 共用字号层级，长标签可换行，触发器允许省略显示 |
| Colors | 现有语义 token；实际合成半透明行背景后测量文字与键盘描边 | 样本在深色为 10.14:1，浅色为 15.11:1；分别超过 4.5:1 / 3:1 |
| UI | 设置、更多、工具、MCP、项目、分支、worktree、补全菜单的外壳与选中态 | 共用 `.app-menu` 和集中定义的菜单参数 |

## 设计依据

- 视觉基准是项目已有的中性桌面主题，以及已确认的设置 / 更多 / 工具预设菜单，
  不引入另一套品牌色、字体、阴影或组件密度。
- [Radix Select](https://www.radix-ui.com/primitives/docs/components/select)：
  使用其实际组件处理焦点、键盘、输入搜索、禁用项、弹层定位和关闭。
- [WAI-ARIA Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/)：
  用作选项语义、选中状态和键盘检查依据；自由输入建议保留输入焦点与活动选项关联。
- [Fluent 2 Menu](https://fluent2.microsoft.design/components/web/react/core/menu/usage)：
  参考其菜单分组、对齐和状态组织方式，外观沿用本项目主题。
- 使用 `better-interface` 综合检查，并分别应用 `better-accessibility`、`better-layout`、
  `better-writing`、`better-typography`、`better-colors`、`better-ui` 和 `interface-design` 的相关原则。

## 统一规则

| 项目 | 约定 |
| --- | --- |
| 弹层表面 | `.app-menu`，不透明 `--surface-elevated`、`--separator`、`--shadow-popover` |
| 外圆角 / 内边距 / 行圆角 | 共享 `--choice-*`：内边距 8px、行圆角 5px（设置页基准）；菜单外圆角 14px = 5 + 8 + 1px 边框 |
| 行高 | 平面单行选项最小 34px；触屏选项最小 44px；双行说明允许更高；复杂树控件保留独立密度 |
| 行间距 | 设置导航与平面菜单共用 `--choice-row-gap: 4px`（Config 基准）；首行不增加额外空白，带星标的选项按整行留距 |
| 内层容器 | 弹层只在外层计算一次内边距，`.app-menu-list` 滚动层不增加 padding；标题和搜索框不改变选项的左右边界 |
| 文本 | 主标签 `--text`，说明 `--text-muted`，不临时拼接另一套灰色 |
| 状态 | 选中使用左侧 3×16px 蓝色短条与背景，与设置导航一致；不使用对号。悬停使用 `--bg-hover`，保留 4px 行间隔 |
| 默认值星标 | 独立于当前选项；空心星可直接点击保存默认值，保存后点亮实心星。无底色、边框或阴影，键盘焦点仍可见 |
| 焦点 | 键盘使用统一 2px `--menu-focus-ring` 描边，采用主题正文色保证清晰可见 |
| 表单选择 | `components/AppSelect.tsx`，公共值保持原样，包括空字符串 |
| 可编辑建议 | `components/AppCombobox.tsx`，允许输入不在建议列表中的目录 |
| 系统菜单 | 业务选项不受构建开关影响，不能恢复成系统原生弹出菜单 |

新菜单优先复用上述组件；现有特殊树形/补全菜单保留各自功能，但必须使用相同外壳与行状态。

## Findings

| 严重性 | 位置 | 原状 | 完成的修复 |
| --- | --- | --- | --- |
| MEDIUM | AgentsConfig、McpAddServer（两处）、McpConfig、ModelsConfig、SettingsPanel、ScheduledTaskEditor（三处） | 共 9 处原生 select，操作系统决定弹出样式 | 全部迁移到 AppSelect，保留选择值、禁用和描述关联 |
| MEDIUM | SessionSidebar、ScheduledTaskEditor | 两处 datalist 仍是系统建议框 | worktree 使用可筛选的应用内分支列表；目录使用 AppCombobox |
| MEDIUM | ProjectPicker、worktree、BranchNavigator、ChatInput 历史及 / @ # 补全 | 部分浮层未接入共享外观，圆角和表面不同 | 所有已声明弹层使用 `.app-menu`，集中定义参数 |
| MEDIUM | lib/desktop-menu.ts | 构建变量仍可恢复不同风格的系统业务菜单 | 关闭业务原生菜单路径，不允许构建变量覆盖 |
| MEDIUM | 菜单维护与键盘焦点 | 缺少防回退约束；焦点样式没有单独统一 | AGENTS.md 明确规则，增加源码结构检查和可重复浏览器检查，统一高对比度描边 |

以上是已修复的问题。普通列表、复杂树形内容、系统任务选择器没有被当成相同的菜单结构强行重排。

## Considered but Rejected

| 候选改动 | 不采用的原因 |
| --- | --- |
| 更换整个应用的颜色、字体或组件框架 | 用户要统一现有风格；引入另一套视觉语言会扩大不一致 |
| 把所有行固定成同一高度 | 工具说明、长模型名和树形内容需要合理换行；统一的是最小行高和间距规则 |
| 仅修改原生 select 的边框 | 无法控制系统弹出列表；使用成熟选择组件才能统一实际选项框 |

## Verification

可重复执行的检查：

```powershell
node --test scripts/ui-menu-consistency.test.mjs
node e2e/option-controls.mjs
```

第二条需要本机可用的 Playwright 浏览器；Windows 默认使用 Edge，其他环境可通过
`E2E_BROWSER_CHANNEL` 指定浏览器。它使用本地模拟数据，阻止外部请求，不访问用户配置或模型。

- 结构检查扫描全部组件，禁止原生 `select` / `datalist`，要求声明为 `native-popover` 的弹层采用共享样式。
- 260 项相关组件、配置、桌面发布和样式边界测试通过；原有上游 CSS 文件未修改。
- TypeScript、相关文件 ESLint、界面生产构建通过。
- 共享组件与实际 MCP 面板覆盖深浅主题 × 三种宽度；验证禁用项跳过、空值与表单值、
  100 项滚动、输入搜索、中文 IME、焦点恢复和自由输入目录。
- 行间距回归覆盖实际 ChatInput 的 Config / 推理级别 / 模型 / 输入历史 / 命令补全，
  以及设置、更多、右键、项目和 worktree 结构样本；在两种主题和 1280 / 390 / 320px
  验证 4px 几何间隙、选中与悬停并存、默认星标位置、网格列对齐和键盘焦点。
- 独立生产资源验证命令 / 文件 / 会话补全，以及移动端设置切换、弹层边界和嵌套 Escape；
  设置 / 更多 / 工具菜单继续验证两种主题、窄窗口和侧面板展开时的可点击性。
- 本地截图与机器结果保存在忽略目录 `test-results/ui-send/`，不作为源码入库。

测试本身同时修正了 Windows 换行规范化和 i18n 测试导入路径，避免同一个上下文重复加载；
MCP 的旧原生 HTML 断言更新为新触发器语义，弹层四个实际选项由浏览器测试覆盖。

## 设置与输入框细节复查（2026-10-20）

| 严重性 | 位置 | 修改前 | 修改后 | 依据 |
| --- | --- | --- | --- | --- |
| MEDIUM | 子代理、模型、技能、插件、MCP 配置列表 | 相邻选中／悬停填充相接，选中项悬停后底色变化 | 共用 8px 留白、4px 间距、5px 行圆角；选中短条与底色保持 | 同类控件共用边界；相邻交互状态必须区分 |
| MEDIUM | 明暗、语言、发送快捷键、Diff、作用域 | 内衬、圆角、分隔线和高亮各自实现 | 共用 4px 内衬及间距（与设置行间距一致）、5px 内圆角、9px 外圆角、柔和选中面 | 同心圆角；共享密度与状态 |
| MEDIUM | 输入框加号与提示语 | SVG 按钮靠底，文字在另一行高内居中 | 加号与首行中心共用计算，提示语和实际文字行高一致；多行时发送仍靠右下 | 图标与正文对齐；跨字号保持几何关系 |

检查使用 `better-ui` 与 `better-layout`，沿用已确认的配色与现有组件。
新回归 `node e2e/settings-controls.mjs` 使用真实七个设置组件、隔离 API 数据，在深浅色及
1280/390/320px 验证行间距、分段四边内衬、内外圆角、相邻悬停和键盘焦点，另测触屏 44px 目标。
`e2e/composer-geometry.mjs` 增加 12/14/20/24px 字号、空输入、中文单行与多行的对齐测量；
通过 `option-controls.mjs` 与 `composer-outbox.mjs` 验证。五种外观保存回归、102 项相关结构测试、
TypeScript 与 lint 通过。以上为实际 React 组件的浏览器测试，未宣称完成整套桌面客户端测试或重新打包。

## Verdict

Approve — 上述业务选项组件范围内，已发现的风格分叉已修复，结构检查与代表性运行态验证通过。
