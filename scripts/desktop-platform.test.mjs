import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { desktopTargetTriple } from "./desktop-platform.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("desktop builds target Apple Silicon, Intel Macs, Linux x64, and Windows x64", () => {
  assert.equal(
    desktopTargetTriple("darwin", "arm64"),
    "aarch64-apple-darwin",
  );
  assert.equal(
    desktopTargetTriple("darwin", "x64"),
    "x86_64-apple-darwin",
  );
  assert.equal(
    desktopTargetTriple("linux", "x64"),
    "x86_64-unknown-linux-gnu",
  );
  assert.equal(
    desktopTargetTriple("win32", "x64"),
    "x86_64-pc-windows-msvc",
  );
});

test("unsupported desktop platforms fail before packaging", () => {
  assert.throws(
    () => desktopTargetTriple("linux", "arm64"),
    /Unsupported desktop platform: linux\/arm64/,
  );
});

test("Linux and Windows packaging include the bundled Node runtime", async () => {
  const [prepareSource, linuxConfigSource, windowsConfigSource] = await Promise.all([
    readFile(join(root, "scripts", "prepare-desktop.mjs"), "utf8"),
    readFile(join(root, "src-tauri", "tauri.linux.conf.json"), "utf8"),
    readFile(join(root, "src-tauri", "tauri.windows.conf.json"), "utf8"),
  ]);
  const linuxConfig = JSON.parse(linuxConfigSource);
  const windowsConfig = JSON.parse(windowsConfigSource);

  assert.match(prepareSource, /process\.platform === "win32" \? "node\.exe" : "node"/);
  assert.match(prepareSource, /node_modules", "npm"/);
  assert.deepEqual(linuxConfig.bundle.targets, ["deb"]);
  assert.ok(linuxConfig.bundle.resources.includes("resources/node"));
  assert.deepEqual(windowsConfig.bundle.targets, ["nsis"]);
  assert.ok(windowsConfig.bundle.icon.includes("icons/icon.ico"));
  assert.ok(windowsConfig.bundle.resources.includes("resources/node"));
});
