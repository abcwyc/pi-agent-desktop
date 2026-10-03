import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const chatInput = await read("./ChatInput.tsx");
const appShell = await read("./AppShell.tsx");
const hook = await read("../hooks/useAgentSession.ts");
const rpcManager = await read("../lib/rpc-manager.ts");

test("the wrapper reports where a virtual model routed and the cache-warming state", () => {
  assert.match(rpcManager, /routedModel: this\.getRoutedModel\(\),\s*cacheWarming: this\.getCacheWarming\(\),/);
  assert.match(rpcManager, /costBreakdown: getUsageCostBreakdown\(this\.inner\.sessionManager\.getEntries\(\)/);
  // Every state sync carries them, so the composer and the panel follow each run.
  assert.match(hook, /setRoutedModel\(state\?\.routedModel \?\? null\);\s*setCacheWarming\(state\?\.cacheWarming \?\? null\);/);
});

test("the composer shows the routed model next to the selector, like pi's footer", () => {
  assert.match(chatInput, /\{routedModel && routedModelName && \(\s*<span\s*className="routed-model-hint"/);
});

test("the session panel lists cost by model and cache warming, refreshed when it opens", () => {
  assert.match(appShell, /shouldShowUsageBreakdown\(sessionStats\.costBreakdown, sessionStats\.selectedModelKey\)/);
  assert.match(appShell, /section\(translate\("session\.costByModel"\), costBreakdownRows\)/);
  assert.match(appShell, /section\(translate\("session\.cacheWarming"\), cacheWarmingSectionRows\)/);
  assert.match(appShell, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sessionPanelSessionId\)\}`\)/);
});
