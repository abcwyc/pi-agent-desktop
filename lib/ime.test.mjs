import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isImeComposing } from "./ime.ts";

test("detects composition from DOM and React keyboard events", () => {
  assert.equal(isImeComposing({ isComposing: true, keyCode: 27 }), true);
  // WebKit reports the key that ends a composition as keyCode 229.
  assert.equal(isImeComposing({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } }), true);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }), true);
  assert.equal(isImeComposing({ isComposing: false, keyCode: 27 }), false);
  assert.equal(isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }), false);
});

// Escape cancels an IME candidate and Enter commits it; these handlers close
// dialogs, submit, or send, so each must skip composing key events. Pinned
// because an upstream merge can silently restore the unguarded handler.
const GUARDED = [
  "hooks/useModalDismiss.ts",
  "components/AppShell.tsx",
  "components/DirectoryPicker.tsx",
  "components/ModelSelector.tsx",
  "components/ProjectPicker.tsx",
  "components/FileExplorer.tsx",
  "components/AgentSessionPanel.tsx",
  "components/ChatWindow.tsx",
  "components/MermaidBlock.tsx",
  "components/ImagePreview.tsx",
  "components/SkillsConfig.tsx",
  "components/SessionSidebar.tsx",
];

test("dialog, menu and inline-input key handlers skip IME composition", () => {
  for (const file of GUARDED) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{ isImeComposing \} from "@\/lib\/ime";/, `${file} must use the shared IME guard`);
    assert.doesNotMatch(source, /\.isComposing\b/, `${file} should use isImeComposing(), which also covers WebKit keyCode 229`);
  }
  // Settings delegates Escape to the shared listener, which skips a composing
  // Enter/Escape itself (see listenForPanelEscape in lib/stacked-dialog.ts).
  const settings = readFileSync(new URL("../components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settings, /listenForPanelEscape\(document, \(\) => \{ if \(!busy\) onClose\(\); \}\)/);
  const stackedDialog = readFileSync(new URL("../lib/stacked-dialog.ts", import.meta.url), "utf8");
  assert.match(stackedDialog, /event\.key !== "Escape" \|\| event\.defaultPrevented \|\| cancelsComposition\(event\)/);
  const modal = readFileSync(new URL("../hooks/useModalDismiss.ts", import.meta.url), "utf8");
  assert.match(modal, /if \(event\.key === "Escape"\) \{\n\s+if \(isImeComposing\(event\)\) return;/);
});
