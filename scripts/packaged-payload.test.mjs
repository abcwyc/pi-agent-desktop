import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PAYLOAD_ALLOWED, assertPayloadClean, findLocalConfigDirs, pruneLocalConfig, resolvePayloadRoot, scanPayload } from "./packaged-payload.mjs";

// The payload scan is the fail-closed half of the fix, so its rules are pinned
// here rather than exercised only by a packaging run.

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), "payload-scan-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const rulesOf = (result) => result.findings.map((finding) => `${finding.rule} ${finding.path}`).sort();

test("a clean payload has no findings", async () => {
  const root = await fixture({
    "server/server.js": "console.log('hi')",
    "server/node_modules/next/package.json": "{}",
    "component-versions.json": "{\"appVersion\":\"0.8.2\"}",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.files, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the checkout's .pi directory is a finding, file or not", async () => {
  const root = await fixture({
    "server/.pi/mcp.json": "{\"mcpServers\":{}}",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), ["local-config server/.pi", "local-config server/.pi/mcp.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Bearer ak_ token is a finding, wherever it sits", async () => {
  const root = await fixture({
    "server/.next-desktop/server/chunks/app.js": "fetch(url,{headers:{authorization:'Bearer ak_live'}})",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), ["bearer-token server/.next-desktop/server/chunks/app.js"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binary false positives for a bare ak_ are not findings", async () => {
  // node.exe / libvips.dll / *.pdb carry ak_malloced, ak_Slovakia, ak_ordering.
  const root = await fixture({
    "node/node.exe": Buffer.concat([
      Buffer.from([0x4d, 0x5a, 0x00, 0x01]),
      Buffer.from("ak_malloced ak_Slovakia ak_ordering"),
    ]),
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an armoured key with a body fails even inside an allowlisted path", async () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\n" + "MIIEowIBAAKCAQEA".padEnd(64, "A") + "\n-----END RSA PRIVATE KEY-----";
  const root = await fixture({
    "node/node_modules/npm/docs/content/using-npm/config.md": key,
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), [
      "private-key-material node/node_modules/npm/docs/content/using-npm/config.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm's documented PRIVATE KEY example is allowlisted and reported", async () => {
  const root = await fixture({
    "node/node_modules/npm/docs/content/using-npm/config.md":
      "For example `-----BEGIN PRIVATE KEY-----` starts a PEM block.",
    "node/node_modules/npm/node_modules/@npmcli/config/lib/definitions/definitions.js":
      "const key = '-----BEGIN PRIVATE KEY-----';",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(
      result.allowed.map((entry) => `${entry.rule} ${entry.path}`).sort(),
      [
        "private-key node/node_modules/npm/docs/content/using-npm/config.md",
        "private-key node/node_modules/npm/node_modules/@npmcli/config/lib/definitions/definitions.js",
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the PEM marker strings inside sharp's macOS libvips are allowlisted", async () => {
  const dylib = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from("\0-----BEGIN PRIVATE KEY-----\0-----BEGIN ENCRYPTED PRIVATE KEY-----\0"),
  ]);
  const root = await fixture({
    "node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib": dylib,
    "node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.7.dylib": dylib,
    "node_modules/@img/sharp-libvips-darwin-x64/lib/notes.txt": "-----BEGIN PRIVATE KEY-----",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), ["private-key node_modules/@img/sharp-libvips-darwin-x64/lib/notes.txt"]);
    assert.equal(result.allowed.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a private key outside the documented-example paths is a finding", async () => {
  const root = await fixture({
    "server/keys/prod.pem": "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), ["private-key server/keys/prod.pem"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a previous run's payload copied into the new one is a finding", async () => {
  const root = await fixture({
    "server/src-tauri/target/release/resources/server/.next-desktop/BUILD_ID": "abc",
    "server/src-tauri/resources/component-versions.json": "{}",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(rulesOf(result), [
      "build-output server/src-tauri/target",
      "build-output server/src-tauri/target/release",
      "build-output server/src-tauri/target/release/resources",
      "build-output server/src-tauri/target/release/resources/server",
      "build-output server/src-tauri/target/release/resources/server/.next-desktop",
      "build-output server/src-tauri/target/release/resources/server/.next-desktop/BUILD_ID",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the packaged manifest beside the server is not build output", async () => {
  const root = await fixture({
    "server/src-tauri/pi-agent-desktop-package.json": "{}",
    "server/src-tauri/resources/component-versions.json": "{}",
  });
  try {
    const result = await scanPayload(root);
    assert.deepEqual(result.findings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruneLocalConfig drops every traced .pi and nothing else", async () => {
  const root = await fixture({
    ".pi/mcp.json": "{\"mcpServers\":{}}",
    "server/.pi/settings.json": "{}",
    "server/.pi2/keep.json": "{}",
    "server/server.js": "console.log('hi')",
  });
  try {
    const removed = await pruneLocalConfig(root);
    assert.deepEqual(removed.sort(), [".pi", "server/.pi"]);
    const result = await scanPayload(root);
    assert.deepEqual(result.findings, []);
    assert.equal(result.files, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertPayloadClean throws and names every finding", async () => {
  const root = await fixture({
    "server/.pi/mcp.json": "{\"mcpServers\":{\"x\":{\"headers\":{\"Authorization\":\"Bearer ak_secret\"}}}}",
  });
  try {
    await assert.rejects(
      () => assertPayloadClean(root, { label: "fixture" }),
      /finding\(s\) in the staged payload/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every allowlist entry targets a rule that exists", () => {
  for (const entry of PAYLOAD_ALLOWED) {
    assert.ok(typeof entry.path.test === "function", entry.reason);
    assert.ok(entry.reason.length > 20, "an allowlist entry must say why");
  }
});

// A scan that saw nothing used to exit 0 and print "0 finding(s)", which reads
// exactly like a clean package: a typo'd --root, an empty staging directory, or
// an absolute path glued onto the checkout all landed there. The
// gate must not be able to pass without looking at files.
test("an empty tree is not a clean payload", async () => {
  const root = await fixture({});
  try {
    await assert.rejects(() => assertPayloadClean(root, { label: "fixture" }), /Nothing to scan/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a payload root must be a relative path that exists", async () => {
  const root = await fixture({ "server/server.js": "ok" });
  try {
    assert.equal(resolvePayloadRoot(root, "server", { exists: () => true }), join(root, "server"));
    assert.throws(() => resolvePayloadRoot(root, ""), /payload root is required/);
    // Absolute inputs are the real trap: join() glues them onto the base, so the
    // scan walks a directory that does not exist and reports nothing.
    assert.throws(() => resolvePayloadRoot(root, "C:/Users/somebody/tree"), /absolute path/);
    assert.throws(() => resolvePayloadRoot(root, "/tmp/tree"), /absolute path/);
    assert.throws(() => resolvePayloadRoot(root, "nope", { exists: () => false }), /does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findLocalConfigDirs reports every .pi at any depth", async () => {
  const root = await fixture({
    "server/.pi/mcp.json": "{}",
    "server/src-tauri/target/release/resources/server/.pi/mcp.json": "{}",
    "node/node.exe": "binary",
  });
  try {
    assert.deepEqual((await findLocalConfigDirs(root)).sort(), [
      "server/.pi",
      "server/src-tauri/target/release/resources/server/.pi",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
