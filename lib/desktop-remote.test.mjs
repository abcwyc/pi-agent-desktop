import assert from "node:assert/strict";
import test from "node:test";
import { isTauriDesktop } from "./desktop-updater.ts";

test("remote backends use browser file workflows instead of local desktop privileges", () => {
  const previous = globalThis.window;
  try {
    delete globalThis.window;
    assert.equal(isTauriDesktop(), false);
    globalThis.window = { __TAURI_INTERNALS__: {} };
    assert.equal(isTauriDesktop(), true);
    globalThis.window.__PI_REMOTE_BACKEND__ = true;
    assert.equal(isTauriDesktop(), false);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("remote window has no native capabilities, including on localhost", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const directory = new URL("../src-tauri/capabilities/", import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const capability = JSON.parse(await readFile(new URL(name, directory), "utf8"));
    assert.ok(!capability.windows?.some((label) => label.includes("*") || label === "remote-backend"), name);
  }
});
