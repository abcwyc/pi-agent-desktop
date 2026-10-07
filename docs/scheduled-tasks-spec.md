# Scheduled（定时任务）设计 Spec

状态:**M1(服务端)已实现并通过端到端验证**,M2(界面)、M3(通知与收尾)未开始。范围:P0 完整定义,P1 列出接口预留,P2 明确不做。

> 本文按实现结果更新过。与最初草案不同的地方集中在 §11「M1 实现记录」。

## 1. 目标与非目标

**目标**:用户在侧边栏 New Session 下方的 **Scheduled** 入口创建、管理"到点自动开一个会话并发送提示词"的任务。任务在本机运行,桌面版关闭窗口(隐藏到托盘)后仍然触发。

**非目标**
- 云端执行(本产品本地优先)。
- 事件触发(git、webhook、文件变化)。
- Thread 模式(每次回到同一会话)。每次运行都是全新会话,避免上下文无限膨胀。
- 睡眠期间唤醒电脑。电脑睡眠错过的运行靠"补跑"兜底。

**命名**:UI 文案 **Scheduled** / **定时任务**。代码、路由、目录统一用 `scheduled-tasks`。`cron` 只作为高级模式的表达式字段名出现。

## 2. 关键设计决策

| # | 决策 | 原因 |
|---|---|---|
| D1 | 调度器是服务端 `globalThis` 单例,不依赖浏览器页面 | 桌面版关窗只是 `hide`(`closeQuits` 默认 false),sidecar server 常驻 |
| D2 | 每次运行 = 一个普通 pi 会话,由 `startRpcSession()` 直接创建 | 与 `app/api/agent/new/route.ts` 同一路径,不自调 HTTP |
| D3 | **默认工具预设 `read-only`**(`PRESET_READ_ONLY` = read/grep/find/ls) | pi 没有权限确认层,无人值守任务不会卡住,也就没有人把关;已有的只读 MCP 策略(`mcp-read-only-policy.ts`)会随预设自动生效 |
| D4 | 调度规则统一存成 cron 表达式 + 时区,预设(每天、工作日等)只是 UI 糖 | 一种存储格式,一个解析路径 |
| D5 | 会话与任务的关联靠 **runs 索引**,不靠扫描 jsonl | 见 §5.3 |
| D6 | 同一时刻只允许一个进程持有调度权(租约文件) | 开发服务器和桌面 App 会同时读写 `~/.pi/agent`,否则同一任务会触发两次 |
| D7 | 跨模块图共享的东西只能放 `globalThis`,错误用 `name` 判断,不用 `instanceof` | 调度器由 `instrumentation` 创建,路由是另一份独立打包的模块实例,类和模块级变量各有一份(实测踩到) |

## 3. 数据模型

### 3.1 任务 `ScheduledTask`

```ts
interface ScheduledTask {
  id: string;                 // uuid
  name: string;               // 展示名,唯一(忽略大小写)
  description?: string;
  prompt: string;             // 触发时作为首条用户消息发送
  cwd: string;                // 绝对路径,保存时必须存在
  schedule:
    | { kind: "manual" }
    | { kind: "cron"; expr: string; timezone: string }   // IANA 时区
    | { kind: "once"; at: string };                       // ISO,触发后自动 enabled=false
  model?: { provider: string; modelId: string };          // 缺省 = 新会话默认模型
  thinkingLevel?: ThinkingLevel;                          // 缺省 = 新会话默认
  toolPreset: "none" | "read-only" | "default" | "full";  // 缺省 "read-only"
  maxDurationMin: number;     // 默认 30,超时 abort
  worktree?: boolean;         // P1
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastScheduledFor?: string;  // 已处理到哪个调度时间点,补跑判定用
  consecutiveFailures: number;// 达到 5 自动 enabled=false
}
```

`nextRunAt` 不落盘,读取时由 cron 计算。

### 3.2 运行记录 `ScheduledRun`

```ts
interface ScheduledRun {
  runId: string;
  taskId: string;
  trigger: "schedule" | "catch-up" | "manual";
  scheduledFor?: string;      // 对应的调度时间点
  startedAt?: string;
  endedAt?: string;
  status: "running" | "succeeded" | "failed" | "aborted" | "skipped";
  skipReason?: "app-asleep" | "overlap";
  skippedSlots?: number;      // 补跑时被丢弃的更早时间点数量
  sessionId?: string;
  error?: string;
  seenAt?: string;            // 用户打开该会话的时间,未读判定
}
```

### 3.3 存储

- 任务:`~/.pi/agent/scheduled-tasks.json`,`{ version: 1, tasks: ScheduledTask[] }`。用 `writePrivateFileAtomicSync()` 原子写。目录与 pi CLI 共享,读取时保留未知字段,写回原样带出(同 `subagent-settings.ts` 的做法)。
- 运行记录:`~/.pi/agent/scheduled-tasks/runs/<taskId>.jsonl`,追加写,每个任务保留最近 200 条(超过时在写入时压缩)。
- 租约:`~/.pi/agent/scheduled-tasks/scheduler.lock`,内容 `{ pid, startedAt, heartbeatAt }`。

任务文件在进程内用一个串行队列写,每次修改"重读 → 修改 → 原子写",不信任内存副本。

## 4. 服务端

### 4.1 目录

```
lib/scheduled-tasks/
  types.ts          数据模型与校验
  store.ts          任务与运行记录读写
  cron.ts           croner 封装:nextRuns / previousRun / 校验 / 最小间隔
  catch-up.ts       纯函数:给定 now、lastScheduledFor、cron,决定 fire / skip / catch-up
  scheduler.ts      tick 循环、租约、并发上限、globalThis 单例
  runner.ts         执行一次运行
  index.ts
app/api/scheduled-tasks/...
instrumentation.ts  服务启动时拉起 scheduler
```

### 4.2 启动

仓库已有 `instrumentation.ts`,它把 Node 专用逻辑转交给 `instrumentation-node.ts`(HTTP dispatcher、SSE 关闭等,桌面包里已经在用)。调度器在 `registerNodeInstrumentation()` 里启动;设 `PI_WEB_DISABLE_SCHEDULER=1` 可关闭(测试、特殊环境用)。理由:route handler 是懒加载的,不能等有人打开页面才开始调度。

已验证:`next dev` 启动后调度器自己拿到租约,早于任何 API 请求。standalone 打包路径依赖同一个 `register()`,桌面包里现有逻辑已在使用它,尚未单独跑一次打包验证。

### 4.3 调度循环

- 每 30 秒 tick 一次。**不用 `setTimeout` 对准下次时间**,因为睡眠和唤醒会让定时器漂移。
- 租约:启动时尝试获取;已被存活进程持有(pid 存在且 `heartbeatAt` 在 90 秒内)则本进程不调度,只提供读写 API。持有者每次 tick 刷新心跳。
- 每个 `enabled` 且 schedule 为 `cron` 的任务:
  1. `due = previousRun(now)`。
  2. 若 `due <= lastScheduledFor`,什么都不做。
  3. 否则:`now - due <= 2 分钟` → 正常触发;更晚但在 7 天内 → **补跑一次**(`trigger: "catch-up"`),`skippedSlots` 记录被丢弃的更早时间点数;超过 7 天的丢弃。
  4. 无论如何把 `lastScheduledFor` 推进到 `due`。
- `once` 任务到点按同样规则触发,完成后 `enabled=false`。
- 重叠:同一任务上一次运行仍是 `running` → 写一条 `skipped / overlap`,不排队。
- 并发:全局最多同时 2 个定时运行。超出的**不领取时间点,留到后面的 tick**;若等待期间出现了更新的时间点,旧的并入 `skippedSlots`。不单独记 `busy` 跳过。手动运行不受该上限约束。
- 时间精度:调度循环每 30 秒一次,所以任务实际启动最多晚到点 30 秒。
- 补跑通知:补跑发生时在运行记录里体现,并通知用户(见 §6)。

### 4.4 运行(`runner.ts`)

1. 校验 `cwd` 存在,否则该次运行记为 `failed`,并计入连续失败(用户需要去修复路径)。
2. P1:`worktree=true` 时先 `addWorktree(cwd, "scheduled/<slug>-<yyyymmdd-hhmm>")`,以新路径为 cwd。
3. `startRpcSession("__sched__<runId>", "", cwd, { toolNames, initialModel, thinkingLevel })`。`toolNames` 来自 `toolPreset`,走现有 `validateSessionToolSelection`,会像普通新会话一样持久化 `pi-web:tool-selection`。
4. 追加自定义 entry `pi-web:scheduled-run`(`{ version: 1, taskId, runId, taskName, trigger, scheduledFor }`),用于索引丢失后的重建与会话内提示。
5. 会话名设为 `<task.name> · MM-DD HH:mm`,走现有重命名路径。
6. `allowFileRoot(cwd)`、`invalidateSessionListCache()`。
7. `session.send({ type: "prompt", message: task.prompt })`,订阅 `session.onEvent()`:
   - `agent_settled` / `prompt_done` → `succeeded`;
   - 事件里出现不可恢复错误 → `failed`;
   - 超过 `maxDurationMin` → 发 abort,记 `aborted`。
8. 写运行记录,更新 `consecutiveFailures`(成功清零,失败 +1,到 5 自动暂停并记录原因),广播事件(§6)。

运行用的是已有的 AgentSession 生命周期,10 分钟空闲回收等行为不需要特殊处理。

### 4.5 API

均受现有请求安全检查和 `proxy.ts` 的 Web 密码保护约束。创建任务等同于持久化的"可执行配置",所以 `cwd` 必须通过与 `/api/agent/new` 相同的校验。

| 方法与路径 | 作用 |
|---|---|
| `GET /api/scheduled-tasks` | 任务列表(含 `nextRunAt`、最近一次运行、未读数)和 `scheduler: { owner: boolean }` |
| `POST /api/scheduled-tasks` | 创建 |
| `PATCH /api/scheduled-tasks/[id]` | 编辑、暂停、恢复 |
| `DELETE /api/scheduled-tasks/[id]` | 删除任务;`?deleteHistory=1` 同时删除运行历史文件。已产生的会话保留不动 |
| `POST /api/scheduled-tasks/[id]/run` | 立即运行 |
| `GET /api/scheduled-tasks/[id]/runs` | 运行历史(分页) |
| `POST /api/scheduled-tasks/[id]/runs/[runId]/seen` | 标记已读 |
| `POST /api/scheduled-tasks/preview` | `{ expr, timezone }` → 校验结果与未来 5 次时间 |
| `GET /api/scheduled-tasks/events` | SSE:运行开始、结束、任务变更 |

校验规则:
- cron 必须能解析;**相邻两次触发间隔不得小于 5 分钟**(控制 LLM 成本,后续可放宽);
- `toolPreset` 为 `default` 或 `full` 时,创建请求必须带 `acknowledgeUnattendedWrites: true`,服务端强制检查(防止只在前端弹窗);
- 名称唯一,`prompt` 非空。

## 5. 与现有系统的结合

### 5.1 侧边栏入口

在 `components/SessionSidebar.tsx` 的 New Session 按钮([SessionSidebar.tsx:1273](../components/SessionSidebar.tsx))下方加一行 `sidebar-header-row`,图标用时钟,文案 `sidebar.scheduled`。右侧显示:未读数徽标;若无未读且有任务运行中,显示小圆点。

点击后主区域切换到 Scheduled 视图,用 URL 参数表达(`?view=scheduled&task=<id>`),遵守"URL 参数优先于持久化工作区"的现有规则。具体接入点在 `AppShell.tsx` 的视图切换处,实现时按其现有的 tab 与 URL 状态管理接入。

样式只写进 `app/native-theme.css`,`globals.css` 与 `settings.css` 保持与上游一致。

### 5.2 Scheduled 视图

- **列表**:名称、调度规则的人话描述、下次运行、最近一次状态、启用开关。
- **详情**:Run now、Active/Paused、Edit、Delete;运行历史(含跳过及原因悬停提示);点击某次运行用现有 `onSelectSession` 打开对应会话。
- **编辑表单**:名称、描述、提示词、工作目录(复用项目选择器)、调度(预设 + 自定义 cron,显示 `preview` 返回的下 5 次时间)、模型、思考等级、工具预设。

**工具预设选择**:默认 `read-only`。选择 `default` 或 `full` 时展开醒目的说明——"该任务无人值守,会直接修改文件或执行命令",并要求勾选确认。选择 `none` 为纯聊天。

### 5.3 运行会话在侧边栏的呈现

现状:`session-reader.ts` 只有在会话带 `parentSession` 时才去读 entries 判断 subagent 关系,普通会话不读。给每个会话都去扫 `pi-web:scheduled-run` entry 会拖慢增量扫描器。

所以:
- 新增 `SessionInfo.relation` 的一种取值 `{ kind: "scheduled"; taskId: string; runId: string }`。
- 它**由 runs 索引在合并会话列表时附加**(内存里 `sessionId → run` 的映射,启动时从 runs 文件构建),不解析 jsonl。
- 带该 relation 的会话**默认不出现在项目树里**(同 subagent 行的处理),避免每小时一个任务淹没项目分组;它们通过 Scheduled 视图的运行历史访问,全局搜索仍然能搜到。
- 自定义 entry 作为持久化的真相来源:runs 文件丢失时可据此重建;会话内还可据此在顶部显示"来自定时任务 X"的提示条。

### 5.4 通知

现有 `lib/desktop-notify.ts` 是**客户端**调用 Tauri 通知插件,窗口聚焦时不通知。方案:服务端经 §4.5 的 SSE 广播 `run_finished`,AppShell 级别的 hook 收到后调用 `notifyDesktop()`,点击通知用 `focusDesktopWindow()` 并跳转到该运行。

隐藏到托盘的 WebView 是否仍保持 JS 与 SSE 存活,需要在 macOS 和 Windows 上实测(§10)。若不成立,回退方案是在 Rust 侧订阅同一 SSE 并直接发系统通知。无论哪种,Scheduled 入口的未读徽标是兜底。

通知开关复用现有的 `notifyOnComplete` 偏好。

### 5.5 项目信任

保存任务时,若 `cwd` 尚未被信任,弹出现有 `ProjectTrustDialog`。运行时行为与普通会话一致:不受信任的项目不加载其 `.pi/extensions`,定时运行无法交互确认,所以不会为它们弹窗。

### 5.6 i18n 与代码归属

- 文案键:`sidebar.scheduled`、`scheduled.*`,同步补 `en`、`zh-CN`、`zh-TW`。
- 新代码尽量放在新文件:`lib/scheduled-tasks/`、`components/scheduled/`、`app/api/scheduled-tasks/`,减少与上游合并时的冲突面。
- 合并后依赖的 fork 接线(侧边栏入口行、`AppShell` 视图分支、`session-reader` 的 relation 附加)加入 `components/fork-extractions.test.mjs` 的哨兵,并在 `scripts/fork-ownership.json` 登记风险等级。
- 文档:新增 `docs/adr/0007-scheduled-tasks.md`(记录 D1–D6)与 `docs/agents/scheduled-tasks.md`(主题说明),并在 `AGENTS.md` 的主题索引里加一行。

## 6. 事件

SSE 事件类型(`/api/scheduled-tasks/events`):

```
task_changed      { taskId }
run_started       { taskId, runId, sessionId, trigger }
run_finished      { taskId, runId, sessionId, status, error? }
run_skipped       { taskId, runId, skipReason }
scheduler_owner   { owner: boolean }
```

客户端凭这个流刷新列表,不轮询;断线重连和 `visibilitychange` 后全量重拉一次。

## 7. 安全与成本护栏

- 默认只读(D3)。写入类预设必须服务端校验确认字段。
- 无人值守任务读取外部内容(网页、issue)时存在提示注入风险,这是默认只读的另一个理由,UI 说明里要提到。
- `maxDurationMin` 默认 30 分钟,到点 abort。
- 最小间隔 5 分钟;全局并发 2;连续失败 5 次自动暂停,并在列表上显示原因。
- 租约保证多进程下不重复触发。
- 删除任务不动已产生的会话;勾选"同时删除运行历史"才删除运行记录文件。

## 8. 测试

纯函数优先,和仓库现有 `.test.mjs` 风格一致:

- `cron.ts`:时区与夏令时的下次时间、最小间隔校验、非法表达式。
- `catch-up.ts`:正常触发、2 分钟内、7 天内补跑、超 7 天丢弃、`skippedSlots` 计数、`once` 任务。
- `store.ts`:往返保留未知字段;并发写入;runs 文件超过 200 条的压缩。
- `scheduler.ts`:租约获取与抢占(伪造 pid 与心跳)、重叠跳过、并发上限。
- `runner.ts`:用桩 session 验证预设到 `toolNames` 的映射、超时 abort、连续失败自动暂停。
- API:校验失败路径,`acknowledgeUnattendedWrites` 强制检查。
- 哨兵:侧边栏入口行与 relation 隐藏逻辑。
- 手工:开发服务器与桌面 App 同时运行时只触发一次;关闭窗口后任务仍触发;睡眠唤醒后补跑一次。

## 9. 里程碑

1. **M1 后端**:types、store、cron、catch-up、scheduler(含租约)、runner、API、`instrumentation.ts`。可用 curl 验证到点触发。
2. **M2 界面**:侧边栏入口、列表与详情、编辑表单、运行历史、会话隐藏与 relation。
3. **M3 收尾**:通知与未读、i18n 三语、哨兵与文档、打包验证(`npm run desktop:prepare && npm run desktop:verify`)。

**P1(接口已预留,不在本期)**:worktree 运行与自动清理;"定时运行此提示词"入口(会话或消息上的按钮,预填表单);通过内置扩展(`builtin:*`,ADR 0006 模式)让 agent 自己创建、查看、暂停任务;保持电脑唤醒开关;"需要关注"的更细分状态。

## 10. 开放问题与待验证项

1. ~~`instrumentation` 是否在服务启动时执行~~ — `next dev` 已验证通过;standalone 打包路径还差一次 `npm run desktop:prepare && npm run desktop:verify` 之后的实机确认(§4.2)。
2. 隐藏到托盘后 WebView 的 SSE 与 JS 是否存活(决定 §5.4 用前端还是 Rust 侧通知)。**仍未验证**,需要在 Tauri 实机上做,无头环境做不了。
3. 会话从项目树隐藏后,打开它时侧边栏没有可高亮的行,AppShell 对"选中但不在树里的会话"的处理需要确认。
4. 会话重命名走哪个现有命令(§4.4 第 5 步),实现时核对。
5. 最小间隔 5 分钟是否过严,上线后看使用情况再调。

## 11. M1 实现记录

**代码位置**:`lib/scheduled-tasks/`(types、cron、catch-up、task-input、store、lease、runner、scheduler、runtime、events、api、index)、`app/api/scheduled-tasks/**`、`instrumentation-node.ts`。新增依赖 `croner@^10`(`package-lock.json` 只多了这一项,tauri 插件的锁定未动)。

**相对草案的变化**
- `skipReason` 只剩 `app-asleep`、`overlap`。目录不存在算 `failed`;并发已满是"推迟"而不是"跳过"。
- 补跑窗口的起点是 `lastScheduledFor`。创建、改调度、恢复暂停时都会把它重置为当前时间,所以暂停期间或改调度之前的时间点不会被补跑。
- 自动暂停的失败计数:超时算失败,用户手动 Stop 不算,进程被杀留下的 `Interrupted` 也不算。
- 校验、默认值、写入类预设的确认字段全部在服务端(`task-input.ts`),前端校验只是便利。
- 删除任务时 `deleteHistory=1` 取代了草案里的 `archiveSessions`:M1 不做会话归档。

**实测踩到的坑(已写进 D7)**
- croner 的 `previousRuns()` 按整秒截断,且**不含**等于参考时间的那个时间点。直接用会在恰好整点 tick 时取到昨天。现用"参考时间 +1 秒"修正,单测覆盖了整点、半秒、整点前半秒。
- Turbopack 下 `instrumentation` 与路由是两份模块实例:调度器抛出的 `RunRejectedError` 在路由里 `instanceof` 为 false,本该 409 的重叠请求变成了 500。改为按 `name` 判断。
- `next dev` 会改写仓库根目录的 `AGENTS.md`(追加 Next 的 agent 规则块),提交前要还原。

**验证**
- 单元与集成:`lib/scheduled-tasks/*.test.mjs` 共 65 个用例(cron、补跑决策、输入校验、存储、租约、运行器、调度器);全仓库 `npm test` 2656 个全部通过,tsc 与 lint 干净。
- 端到端:隔离的 `PI_CODING_AGENT_DIR` + 本地假 OpenAI 兼容模型 + 真实 `next dev`,走真实 HTTP。已验证:创建与校验(415、跨域 403、写入预设缺确认 400)· cron 预览 · 手动运行(会话含 `pi-web:scheduled-run` 标记、已命名、模型实际收到的工具恰为 `read/grep/find/ls`)· 真实重叠返回 409 · 一次性任务无人操作下自动触发并自动停用 · 并发上限 2 · 上游 500 的失败路径与计数 · SSE 事件 · 重启后任务保留 · `kill -9` 后租约接管与 `running` 记录收尾。
- 未验证:Tauri 实机(托盘隐藏下的通知)、standalone 打包路径、睡眠唤醒的真实补跑(逻辑由单测覆盖,没有真的让机器睡眠)。

**M2 起点**:`sessionId → run` 的内存索引(§5.3)、侧边栏入口行与 Scheduled 视图、会话从项目树隐藏。
