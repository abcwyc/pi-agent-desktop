import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { getNetworkExposureWarning } = require("../bin/network-exposure-warning.js");
const scriptPath = new URL("../bin/network-exposure-warning.js", import.meta.url).pathname;

test("stays silent on loopback hostnames", () => {
  for (const hostname of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
    assert.equal(getNetworkExposureWarning(hostname, {}), null);
  }
});

test("warns that a public listener without a password is unauthenticated", () => {
  const warning = getNetworkExposureWarning("0.0.0.0", {});
  assert.match(warning, /0\.0\.0\.0 without authentication/);
  assert.match(warning, /PI_WEB_PASSWORD/);
});

test("warns about plain HTTP instead when a password is set", () => {
  const warning = getNetworkExposureWarning("0.0.0.0", { PI_WEB_PASSWORD: "secret" });
  assert.match(warning, /password authentication over HTTP/);
  assert.doesNotMatch(warning, /without authentication/);
});

test("the CLI form prints to stderr only for non-loopback hosts", () => {
  const env = { ...process.env };
  delete env.PI_WEB_PASSWORD;
  const lan = spawnSync(process.execPath, [scriptPath, "0.0.0.0"], { env, encoding: "utf8" });
  assert.equal(lan.status, 0);
  assert.match(lan.stderr, /without authentication/);
  const local = spawnSync(process.execPath, [scriptPath, "127.0.0.1"], { env, encoding: "utf8" });
  assert.equal(local.status, 0);
  assert.equal(local.stderr, "");
});

test("the lan scripts print the warning before starting Next", async () => {
  const { readFile } = await import("node:fs/promises");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const name of ["dev:lan", "start:lan"]) {
    assert.match(pkg.scripts[name], /^node bin\/network-exposure-warning\.js 0\.0\.0\.0 && next /, name);
  }
});
