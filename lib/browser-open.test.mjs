import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  followChildUntilExit,
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

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
  };
  child.stdout = new EventEmitter();
  return child;
}

test("followChildUntilExit waits for the child and forwards shutdown signals", () => {
  const child = fakeChild();
  const listeners = new Map();
  const exits = [];
  const selfSignals = [];
  const stdout = new EventEmitter();

  followChildUntilExit(child, {
    on: (name, handler) => listeners.set(name, handler),
    off: (name) => listeners.delete(name),
    exit: (code) => exits.push(code),
    killSelf: (signal) => selfSignals.push(signal),
    stdout,
  });

  listeners.get("SIGINT")();
  assert.deepEqual(child.killedWith, ["SIGINT"]);

  child.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  child.emit("exit", 0, null);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(selfSignals, []);
  assert.equal(listeners.size, 0);
});

test("followChildUntilExit re-raises the child's shutdown signal", () => {
  const child = fakeChild();
  const listeners = new Map();
  const selfSignals = [];

  followChildUntilExit(child, {
    on: (name, handler) => listeners.set(name, handler),
    off: (name) => listeners.delete(name),
    exit: () => {
      throw new Error("should re-raise the signal instead of process.exit");
    },
    killSelf: (signal) => selfSignals.push(signal),
    stdout: new EventEmitter(),
  });

  child.emit("exit", null, "SIGINT");
  assert.deepEqual(selfSignals, ["SIGINT"]);
});
