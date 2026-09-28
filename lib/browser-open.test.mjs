import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  isWsl,
  shouldOpenBrowser,
  canonicalLoopbackUrl,
  resolveBrowserOpenArgv,
  writeStdout,
  attachReadyHandoff,
} = require("./browser-open.js");

test("detects WSL from distro name, interop, or kernel release", () => {
  assert.equal(isWsl({ env: { WSL_DISTRO_NAME: "Ubuntu-26.04" }, release: "6.8.0-generic" }), true);
  assert.equal(isWsl({ env: { WSL_INTEROP: "/run/WSL/1_interop" }, release: "6.8.0-generic" }), true);
  assert.equal(isWsl({ env: {}, release: "6.6.114.1-microsoft-standard-WSL2" }), true);
  assert.equal(isWsl({ env: { WSL_DISTRO_NAME: "" }, release: "6.8.0-generic" }), false);
  assert.equal(isWsl({ env: {}, release: "6.8.0-generic" }), false);
});

test("skips the browser handoff over SSH", () => {
  assert.equal(shouldOpenBrowser({}), true);
  assert.equal(shouldOpenBrowser({ SSH_CONNECTION: "172.18.0.1 1234 10.0.0.1 22" }), false);
  assert.equal(shouldOpenBrowser({ SSH_TTY: "/dev/pts/0" }), false);
  assert.equal(shouldOpenBrowser({ SSH_CONNECTION: "", SSH_TTY: "" }), true);
});

test("canonical URL is always IPv4 loopback", () => {
  assert.equal(canonicalLoopbackUrl("30141"), "http://127.0.0.1:30141");
  assert.equal(canonicalLoopbackUrl("8080"), "http://127.0.0.1:8080");
});

test("builds macOS, WSL, Windows, and Linux open argv without spawning", () => {
  const url = "http://127.0.0.1:30141";
  assert.deepEqual(resolveBrowserOpenArgv(url, { platform: "darwin", isWsl: false }), ["open", [url]]);
  assert.deepEqual(
    resolveBrowserOpenArgv(url, { platform: "linux", isWsl: true }),
    ["powershell.exe", ["-NoProfile", "-Command", "Start-Process 'http://127.0.0.1:30141'"]],
  );
  assert.deepEqual(
    resolveBrowserOpenArgv(url, { platform: "win32", isWsl: false }),
    ["powershell.exe", ["-NoProfile", "-Command", "Start-Process 'http://127.0.0.1:30141'"]],
  );
  assert.deepEqual(resolveBrowserOpenArgv(url, { platform: "linux", isWsl: false }), ["xdg-open", [url]]);
});

test("PowerShell single-quotes the URL and doubles embedded quotes", () => {
  const url = "http://127.0.0.1:30141/foo'bar";
  const [command, args] = resolveBrowserOpenArgv(url, { platform: "linux", isWsl: true });
  assert.equal(command, "powershell.exe");
  assert.deepEqual(args, ["-NoProfile", "-Command", "Start-Process 'http://127.0.0.1:30141/foo''bar'"]);
  assert.equal(command.includes("cmd.exe"), false);
});

test("WSL never uses xdg-open or cmd.exe", () => {
  const [command, args] = resolveBrowserOpenArgv("http://127.0.0.1:30141", {
    platform: "linux",
    isWsl: true,
  });
  assert.equal(command, "powershell.exe");
  assert.equal(args.includes("xdg-open"), false);
  assert.match(args.join(" "), /Start-Process /);
});

function captureHandoff({ wantOpen, open, chunks }) {
  const stdout = new PassThrough();
  const logs = [];
  const errors = [];
  const opens = [];
  attachReadyHandoff(stdout, {
    port: "30141",
    wantOpen,
    log: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    open: open ?? (async (url) => {
      opens.push(url);
    }),
    forward: () => {},
  });
  for (const chunk of chunks) stdout.write(chunk);
  return { logs, errors, opens };
}

function flushHandoff() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("prints the canonical URL on Ready and opens once", async () => {
  const { logs, errors, opens } = captureHandoff({
    wantOpen: true,
    chunks: ["Compiling...\n", "✓ Ready in 1.2s\n", "✓ Ready in 0.1s\n"],
  });
  await flushHandoff();
  assert.deepEqual(logs, [
    "pi-web: http://127.0.0.1:30141",
    "pi-web: opening the default browser; pass --no-open to disable",
  ]);
  assert.deepEqual(opens, ["http://127.0.0.1:30141"]);
  assert.deepEqual(errors, []);
});

test("skips the open when wantOpen is false but still prints the URL", async () => {
  const { logs, opens } = captureHandoff({
    wantOpen: false,
    chunks: ["Ready\n"],
  });
  await flushHandoff();
  assert.deepEqual(logs, ["pi-web: http://127.0.0.1:30141"]);
  assert.deepEqual(opens, []);
});

test("handoff failure is a warning and does not throw", async () => {
  const { logs, errors } = captureHandoff({
    wantOpen: true,
    open: async () => {
      throw new Error("powershell.exe was not found on PATH");
    },
    chunks: ["Ready\n"],
  });
  await flushHandoff();
  assert.equal(logs[0], "pi-web: http://127.0.0.1:30141");
  assert.match(
    errors[0],
    /could not open the default browser because powershell.exe was not found on PATH; use the URL printed above/,
  );
});

test("writeStdout swallows EPIPE and skips closed streams", () => {
  const epipe = new Error("write EPIPE");
  epipe.code = "EPIPE";
  writeStdout("x", {
    writable: true,
    write() {
      throw epipe;
    },
  });

  let writes = 0;
  writeStdout("x", {
    writable: false,
    write() {
      writes += 1;
    },
  });
  assert.equal(writes, 0);

  const other = new Error("write EIO");
  other.code = "EIO";
  assert.throws(
    () => writeStdout("x", {
      writable: true,
      write() {
        throw other;
      },
    }),
    { code: "EIO" },
  );
});

test("pi-web and npm run web share the handoff helper", () => {
  const launcher = readFileSync(new URL("../bin/pi-web.js", import.meta.url), "utf8");
  const webDev = readFileSync(new URL("../scripts/web-dev.mjs", import.meta.url), "utf8");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(launcher, /attachReadyHandoff/);
  assert.match(launcher, /wireChildProcessLifecycle/);
  assert.doesNotMatch(launcher, /followChildUntilExit/);
  assert.equal(launcher.includes("xdg-open"), false);
  assert.equal(launcher.includes("cmd.exe"), false);

  assert.match(webDev, /attachReadyHandoff/);
  assert.match(webDev, /wireChildProcessLifecycle/);
  assert.match(webDev, /"dev", "-H", "127.0.0.1"/);
  assert.equal(pkg.scripts.dev, "next dev -H 127.0.0.1 -p 30141");
  assert.equal(pkg.scripts.web, "node scripts/web-dev.mjs");
});
