import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const rustSource = await readFile(
  new URL("../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

test("routes native macOS menu actions into app state", () => {
  assert.match(appShellSource, /listen<string>\("pi-agent-menu-action"/);
  assert.match(appShellSource, /payload === "new-session"/);
  assert.match(appShellSource, /payload === "settings-general" \|\| payload === "settings-models"/);
  assert.match(appShellSource, /setSettingsSection\(payload === "settings-general" \? "general" : "models"\)/);
});

test("installs the standard macOS app menu", () => {
  assert.match(rustSource, /fn build_macos_app_menu\(app: &AppHandle\)/);
  assert.match(rustSource, /PredefinedMenuItem::about/);
  assert.match(rustSource, /PredefinedMenuItem::services/);
  assert.match(rustSource, /PredefinedMenuItem::undo/);
  assert.match(rustSource, /PredefinedMenuItem::fullscreen/);
  assert.match(rustSource, /app\.set_menu\(menu\)\?/);
});
