"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");

function isNonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function isWsl({ env = process.env, release = os.release() } = {}) {
  return isNonEmpty(env.WSL_DISTRO_NAME)
    || isNonEmpty(env.WSL_INTEROP)
    || String(release).toLowerCase().includes("microsoft");
}

function shouldOpenBrowser(env = process.env) {
  return !isNonEmpty(env.SSH_CONNECTION) && !isNonEmpty(env.SSH_TTY);
}

function canonicalLoopbackUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function powershellStartProcess(url) {
  const literal = `'${String(url).replace(/'/g, "''")}'`;
  return ["powershell.exe", ["-NoProfile", "-Command", `Start-Process ${literal}`]];
}

function resolveBrowserOpenArgv(url, { platform = process.platform, isWsl: wsl = isWsl() } = {}) {
  if (platform === "darwin") {
    return ["open", [url]];
  }
  if (wsl || platform === "win32") {
    return powershellStartProcess(url);
  }
  return ["xdg-open", [url]];
}

function shortSpawnReason(error, command) {
  if (error && error.code === "ENOENT") {
    return `${command} was not found on PATH`;
  }
  return error?.message || "spawn failed";
}

function openBrowser(url, options = {}) {
  const [command, args] = resolveBrowserOpenArgv(url, options);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", (error) => {
      reject(new Error(shortSpawnReason(error, command)));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function isEpipe(error) {
  return Boolean(error && error.code === "EPIPE");
}

function writeStdout(text, stream = process.stdout) {
  if (!stream.writable) return;
  try {
    stream.write(text);
  } catch (error) {
    if (!isEpipe(error)) throw error;
  }
}

const epipeGuarded = new WeakSet();

function ignoreEpipe(stream) {
  if (!stream || epipeGuarded.has(stream)) return;
  epipeGuarded.add(stream);
  stream.on("error", (error) => {
    if (!isEpipe(error)) throw error;
  });
}

function attachReadyHandoff(stdout, {
  port,
  wantOpen,
  log = console,
  open = openBrowser,
  forward = (text) => writeStdout(text),
} = {}) {
  const url = canonicalLoopbackUrl(port);
  let opened = false;

  stdout.on("data", (chunk) => {
    const text = String(chunk);
    forward(text);
    if (opened || !text.includes("Ready")) return;
    opened = true;
    log.log(`pi-web: ${url}`);
    if (!wantOpen) return;
    log.log("pi-web: opening the default browser; pass --no-open to disable");
    Promise.resolve()
      .then(() => open(url))
      .catch((error) => {
        log.error(`pi-web: could not open the default browser because ${error.message}; use the URL printed above`);
      });
  });
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function followChildUntilExit(child, {
  signals = ["SIGINT", "SIGTERM"],
  on = (name, handler) => process.on(name, handler),
  off = (name, handler) => process.removeListener(name, handler),
  exit = (code) => process.exit(code),
  killSelf = (signal) => process.kill(process.pid, signal),
  stdout = process.stdout,
} = {}) {
  ignoreEpipe(child.stdout);
  ignoreEpipe(stdout);

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      if (childHasExited(child)) return;
      child.kill(signal);
    };
    handlers.set(signal, handler);
    on(signal, handler);
  }

  child.once("exit", (code, signal) => {
    for (const [name, handler] of handlers) off(name, handler);
    if (signal) {
      killSelf(signal);
      return;
    }
    exit(code ?? 0);
  });
}

module.exports = {
  isWsl,
  shouldOpenBrowser,
  canonicalLoopbackUrl,
  resolveBrowserOpenArgv,
  openBrowser,
  writeStdout,
  attachReadyHandoff,
  followChildUntilExit,
};
