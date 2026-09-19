import assert from "node:assert/strict";
import test from "node:test";
import {
  TOOL_PRESET_STORAGE_KEY,
  getPresetFromTools,
  getToolNamesForPreset,
  isToolPreset,
  readStoredToolPreset,
  storeToolPreset,
} from "./tool-presets.ts";

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    dump: () => data,
  };
}

test("isToolPreset accepts only known presets", () => {
  assert.equal(isToolPreset("none"), true);
  assert.equal(isToolPreset("default"), true);
  assert.equal(isToolPreset("full"), true);
  assert.equal(isToolPreset("off"), false);
  assert.equal(isToolPreset(null), false);
  assert.equal(isToolPreset(undefined), false);
});

test("storeToolPreset/readStoredToolPreset round-trip", () => {
  const storage = fakeStorage();
  storeToolPreset("full", storage);
  assert.equal(storage.dump().get(TOOL_PRESET_STORAGE_KEY), "full");
  assert.equal(readStoredToolPreset(storage), "full");
});

test("readStoredToolPreset ignores unknown or missing values", () => {
  assert.equal(readStoredToolPreset(fakeStorage({ [TOOL_PRESET_STORAGE_KEY]: "everything" })), null);
  assert.equal(readStoredToolPreset(fakeStorage()), null);
  assert.equal(readStoredToolPreset(null), null);
});

test("storage failures never throw", () => {
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readStoredToolPreset(throwing), null);
  assert.doesNotThrow(() => storeToolPreset("full", throwing));
});

test("full preset still resolves to all seven built-in tools", () => {
  assert.deepEqual(getToolNamesForPreset("full"), ["bash", "read", "edit", "write", "grep", "find", "ls"]);
  const full = getToolNamesForPreset("full").map((name) => ({ name, description: "", active: true }));
  assert.equal(getPresetFromTools(full), "full");
});
