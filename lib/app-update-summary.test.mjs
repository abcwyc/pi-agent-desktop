import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { parseReleaseHighlights } = await jiti.import("./app-updates.ts");
const { summarizeReleaseHighlights } = await jiti.import("./app-update-summary.ts");

// Shaped like the bilingual notes release.yml publishes.
const body = `## Pi Agent Desktop 0.8.3

### New

- **Network proxy.** Settings › General › "Network proxy": turn it on.
- **Side chats.** Ask a side question without interrupting the session.
- **Sidebar.** "Pin" a project.
- **Files and right panel.** Drag right-panel tabs to reorder them.
- **Models.** Set the context window of a built-in model.

### Improved

- **Merged pi-web 0.15.0.** Prompts wait.

### Fixed

- **Security:** a header could skip the password check.

---

## Pi Agent Desktop 0.8.3

### 新增

- **网络代理。** “设置 › 常规 › 网络代理”。
- **侧聊。** 不打断当前会话也能另问一个问题。
- **侧栏。** 可以置顶。
- **文件与右侧面板。** 标签页可以拖动排序。
- **模型。** 可以设置上下文窗口。

### 改进

- **合并 pi-web 0.15.0。** 提示词会等待。
`;

test("release highlights are the bold lead-ins under New, per language", () => {
  assert.deepEqual(parseReleaseHighlights(body), {
    en: ["Network proxy", "Side chats", "Sidebar", "Files and right panel", "Models"],
    zh: ["网络代理", "侧聊", "侧栏", "文件与右侧面板", "模型"],
  });
});

test("a release without New falls back to Improved; no notes means no highlights", () => {
  assert.deepEqual(parseReleaseHighlights("### Improved\n\n- **Faster start.** x\n"), { en: ["Faster start"], zh: [] });
  assert.equal(parseReleaseHighlights(""), undefined);
  assert.equal(parseReleaseHighlights(null), undefined);
  assert.equal(parseReleaseHighlights("Just text."), undefined);
});

test("the Chinese summary stays within 20 characters and says 等 when items are left out", () => {
  const highlights = parseReleaseHighlights(body);
  const zh = summarizeReleaseHighlights(highlights, "zh-CN");
  assert.equal(zh, "网络代理、侧聊、侧栏、文件与右侧面板等");
  assert.ok(zh.length <= 20);
  assert.equal(summarizeReleaseHighlights(highlights, "zh-TW"), zh);
  const en = summarizeReleaseHighlights(highlights, "en");
  assert.ok(en.length <= 48);
  assert.match(en, /^Network proxy, Side chats, Sidebar/);
});

test("summaries fall back across languages and cut a single long title", () => {
  assert.equal(summarizeReleaseHighlights({ en: ["Proxy"], zh: [] }, "zh-CN"), "Proxy");
  assert.equal(summarizeReleaseHighlights({ en: [], zh: [] }, "en"), null);
  assert.equal(summarizeReleaseHighlights(undefined, "en"), null);
  const long = summarizeReleaseHighlights({ en: [], zh: ["一二三四五六七八九十一二三四五六七八九十一二"] }, "zh-CN");
  assert.equal(long.length, 20);
  assert.ok(long.endsWith("…"));
});
