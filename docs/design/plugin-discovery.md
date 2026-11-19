# 插件发现：初步设计

状态：讨论稿。独立 HTML 原型，不改动应用代码、不安装插件。

## 范围

在 Settings › 插件内增加发现入口，保留现有已安装管理和手动来源添加。技能在下一阶段复用 skills.sh 搜索和安装。没有独立市场路由、私有索引、扩展 API 或配置格式。

原型：`plugin-discovery-prototype.html`。可搜索固定样本、切换全局/项目目标、模拟安装、切换主题。窄屏布局仅展示内容适配，正式实现必须沿用 SettingsPanel 的手机层级导航。原型的已安装状态只是内存演示，刷新即清空。

## 真实样本与证据

查询 npm `/-/v1/search?text=keywords%3Api-package&size=8`，再逐个读取 registry 的 `/<name>/latest`。下面版本来自本次查询快照，不自动代表当前最新版。已核对 pi 资源声明，未下载包、安装或验证桌面兼容性。简介为原始英文描述的中文概括。

| 包 | 查询版本 | 声明的资源 | 简介 |
| --- | --- | --- | --- |
| [pi-web-access](https://www.npmjs.com/package/pi-web-access) | 0.48.0 | extensions | 网页搜索、抓取、PDF、视频 |
| [@postman/postman-plugin](https://www.npmjs.com/package/@postman/postman-plugin) | 0.8.0 | extensions、skills | API 工程技能与 pi 扩展 |
| [openwiki](https://www.npmjs.com/package/openwiki) | 0.9.0 | extensions、skills | 代码库 Wiki 生成与维护 |
| [@onkernel/browser-loop](https://www.npmjs.com/package/@onkernel/browser-loop) | 0.12.1 | extensions | 浏览器工具与 Kernel 执行 |
| [pi-subagents](https://www.npmjs.com/package/pi-subagents) | 0.89.0 | extensions、skills、prompts | 子代理和工作流 |
| [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) | 7.0.1 | extensions | MCP 适配 |

`pi-package` keyword 是发布者声明，不能当作兼容认证。browser-loop 样本还声明 pi-agent-core 0.83.0 精确 peer dependency，说明发现与兼容验证必须区分。子代理和 MCP 扩展可能与内置能力重叠，保留现有资源加载和冲突诊断。样本清单是设计证据，不是将来的生产索引或推荐名单。

## 交互

- 插件面板列表顶部增加「发现插件」，下面保留「通过来源添加」和已有全局/项目分组。
- 发现区顶部：标题、统一安装目标与保存路径、搜索框、来源。
- 宽屏双列条目，窄屏单列；实际断点根据设置面板可用宽度确定。
- 条目显示包名、简介、版本、发布者、npm 链接、安装状态。只有详情元数据提供 pi manifest 时显示资源类型，不能仅从 keyword 猜测。
- 默认按 npm 搜索返回顺序，称「搜索结果」；不虚构热门、精选、官方认证或评分。
- 安装复用现有 action，成功后保留搜索位置并刷新已安装列表。已安装状态按所选 scope 判断；Git/本地来源不能与同名 npm 包贸然等同。
- 项目不可写时沿用现有 trust 提示和禁用原因；不为发现引入新的确认流程。
- 安装错误留在对应条目，允许重试；搜索失败不清空已有内容。依赖身份、认证和重载的行为沿用当前实现。

## 技术方案

新增 GET `/api/plugins/search?q=&offset=&limit=`，服务端访问固定 npm registry 搜索地址，将用户关键词与 `keywords:pi-package` 组合，限制长度、页大小和超时，核对结果 keyword。响应只返回必要元数据与分页信息，不返回发布者邮箱。按查询短期缓存，取消过期前端请求并以请求序号阻止旧结果覆盖新结果。不能让调用方指定上游 URL。

npm 搜索结果不一定包含 pi manifest、README、准确资源类型或兼容性信息。首版列表只使用现有字段；若需要详情，则用户打开详情时单独读取包元数据，不为每个搜索条目立即追加请求。显示发布者 username 或维护者身份时明确字段含义，不把 repository owner 当作发布者。

安装仍 POST `/api/plugins`：`{ action: 'install', source: 'npm:<name>', scope, cwd }`。服务端沿用请求保护、项目访问和 trust 校验、SDK installAndPersist、模型运行时失效以及现有重载提示。首版沿用已有默认版本安装语义，点击时 latest 可能变化，界面不声称锁定搜索快照版本。

主改动：PluginsConfig、PluginDiscovery（新增）、plugins/search route（新增）、API types、三种语言翻译、native-theme.css。复用 SettingsUi 和 AppSelect；不改 globals.css/settings.css，不引入运行时依赖。技能后续单独 PR，复用已有 skills/search 与 skills/install。

## 验证和交付

搜索参数、上游异常与超时、分页、过滤、过期响应、scope 下的安装状态和安装动作做针对性验证。自动化安装只在临时 agent dir 中进行。检查桌面/手机、明暗主题、键盘与已有安装管理无回归。

执行项目要求的 npm test、tsc --noEmit、npm run lint；涉及菜单时补 ui-menu-consistency 与 option-controls。先对齐此设计，再按 CONTRIBUTING 建功能 issue 讨论，之后开发并开 PR；不自动向外发布讨论。
