import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInstalledFonts, installedFontLabel } from "./installed-fonts.ts";

test("installed fonts keep localized names, deduplicate and reject unsafe families", () => {
  const fonts = normalizeInstalledFonts([
    { family: "Microsoft YaHei", names: [{ lang: "zh-cn", name: "微软雅黑" }, { lang: "zh-tw", name: "微軟雅黑" }] },
    { family: "microsoft yahei" }, { family: "Consolas" }, { family: "User Installed UI" },
    { family: "@Microsoft YaHei" }, { family: "Arial; color:red" }, null, { family: 5 },
  ]);
  assert.deepEqual(fonts.map((f) => f.family), ["Consolas", "Microsoft YaHei", "User Installed UI"]);
  assert.equal(installedFontLabel(fonts[1], "zh-CN"), "微软雅黑 (Microsoft YaHei)");
  assert.equal(installedFontLabel(fonts[1], "zh-TW"), "微軟雅黑 (Microsoft YaHei)");
  assert.equal(installedFontLabel(fonts[1], "en"), "Microsoft YaHei");
  assert.throws(() => normalizeInstalledFonts({ family: "Arial" }));
});
