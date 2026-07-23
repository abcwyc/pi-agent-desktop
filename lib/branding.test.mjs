import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url);
const {
  APP_DISTRIBUTION_NAME,
  APP_VERSION,
  APP_VERSION_DISPLAY,
  PRODUCT_NAME,
} = await jiti.import("./branding.ts");

const userFacingFiles = [
  "app/layout.tsx",
  "components/AppShell.tsx",
  "components/ChatWindow.tsx",
  "components/SessionSidebar.tsx",
  "components/UpdateReminder.tsx",
];

test("locks the local user-facing product name", () => {
  assert.equal(PRODUCT_NAME, "Pi Agent");
  assert.equal(APP_DISTRIBUTION_NAME, "pi-agent-desktop");
  assert.equal(APP_VERSION, "0.1.0");
  assert.equal(APP_VERSION_DISPLAY, "0.1");
  for (const relativePath of userFacingFiles) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /Pi Web/, `${relativePath} must use PRODUCT_NAME`);
  }

  const desktopSource = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
  assert.match(desktopSource, /\.title\("Pi Agent"\)/);
});

test("keeps build versions out of the interface", () => {
  const files = [
    "next.config.ts",
    "components/ChatWindow.tsx",
    "components/SessionSidebar.tsx",
  ];
  for (const relativePath of files) {
    const source = readFileSync(join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /NEXT_PUBLIC_(?:APP|PI)_VERSION/, `${relativePath} exposes a version badge`);
  }
});
