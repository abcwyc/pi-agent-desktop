# Web profile (browser surface) — v1

Status: `npm run web` and production `pi-web` share the loopback handoff helper.

This is the **browser** path: the Next/agent process runs on the current OS, and
the operator's default desktop browser displays it. It is not Tauri, and it is
not a DeepSeek Harness Cordis `--profile web` port.

v1 platforms: **WSL2 (Windows browser)** and **macOS**.

Related: [WSL2 desktop feasibility](./wsl2-feasibility.md) is the Tauri/Windows
shell plan. Do not merge the two. That document's Option C (manual browser
spike) is what this spec turns into a first-class launch mode.

---

## 1. What "web profile" means here

In this repo, "web profile" means:

> One command starts the in-process Pi agent inside a Next.js server bound to
> loopback, prints `http://127.0.0.1:<port>`, and opens that URL in the desktop
> browser that belongs to the human in front of the machine.

The agent, tools, git, worktrees, and `~/.pi/agent` live in the server process
OS. The browser is only an HTTP client.

```
WSL2 or macOS shell
  └─ next dev | pi-web          AgentSession in-process
       └─ http://127.0.0.1:30141
            └─ Windows Chrome/Edge   (from WSL)
            └─ macOS Safari/Chrome   (from macOS)
```

This already matches how the repo works (`npm run dev` on port 30141). v1 adds
a dedicated launch entry and a WSL-aware browser handoff so the Windows browser
opens from a WSL shell the same way `open` already works on macOS.

### What this is not

| Tempting copy | Why not in v1 |
|---|---|
| DSH `dsh --profile web` / Cordis patches | This repo has no plugin composition. The Next server *is* the surface. |
| DSH process-token cookie auth | Loopback + existing Host/Origin fence + optional `PI_WEB_PASSWORD` is the v1 trust model. |
| `--host 0.0.0.0` as the WSL trick | Exposes agent RCE to the network. WSL→Windows uses loopback. |
| Tauri WebView attached to a WSL server | Trust, identity, path translation, process lifetime — see [wsl2-feasibility.md](./wsl2-feasibility.md). |
| Pointing `PI_CODING_AGENT_DIR` at `/mnt/c/...` | Mixes Windows and Linux path semantics. Each OS keeps its own store. |

---

## 2. v1 scope

### In

- WSL2: run the server inside the distro; open the **Windows** default browser.
- macOS: run the server on the Mac; open the macOS default browser with `open`.
- Bind `127.0.0.1` only on this launch path. Default port `30141`.
- Always print the canonical URL `http://127.0.0.1:<port>`.
- Open the browser after the server is actually listening (`Ready`).
- `--no-open` / `PI_WEB_NO_OPEN` skip the handoff; the server still runs.
- Non-empty `SSH_CONNECTION` or `SSH_TTY` skip the handoff (SSH client owns the
  forwarded address). Still print the URL.
- Handoff failure is a stderr warning. The server stays up. The printed URL is
  the manual fallback.
- Existing `lib/request-security.ts` Host/Origin fence is unchanged.
- Desktop-only routes (`/api/desktop/*`) stay Tauri-gated and degrade in a
  normal browser. That is expected.

### Out of v1

- Native Windows (non-WSL) as a validation target. The helper may still handle
  `win32` because it is cheap; it is not a v1 gate.
- Generic Linux desktop (`xdg-open`). Keep as a fallback, do not promise it.
- LAN / all-interfaces bind as a substitute for WSL loopback. `npm run dev:lan`
  remains a separate, explicitly networked command.
- NAT-mode WSL without localhost forwarding. v1 requires mirrored networking
  with `hostAddressLoopback=true` (the topology already audited on this host).
- Sharing `~/.pi/agent` live across Windows and WSL.
- Auto-pairing a Tauri window to this server.

---

## 3. Launch contract

Keep `npm run dev` as it is today: no auto-open, no extra wrapper. Developers
who already have a tab can keep using it.

Add a web-profile entry that *does* hand off:

```bash
npm run web                 # next dev -H 127.0.0.1 -p 30141, then open
npm run web -- --no-open    # same server, print URL only
npm run web -- -p 8080      # override port
```

Production launcher (`bin/pi-web.js`) uses the same handoff helper, so a built
`pi-web` from WSL or macOS behaves the same way.

Printed lines (English, stable enough to grep):

```text
pi-web: http://127.0.0.1:30141
pi-web: opening the default browser; pass --no-open to disable
```

If the handoff is skipped (SSH or `--no-open`):

```text
pi-web: http://127.0.0.1:30141
```

If the handoff fails:

```text
pi-web: could not open the default browser because <reason>; use the URL printed above
```

Canonical URL is always `http://127.0.0.1:<port>`, even if the operator passed
`-H localhost`. Never print `0.0.0.0` as a clickable URL.

Do not run `next build` on this path. Same rule as `npm run dev`.

---

## 4. Bind, reachability, networking

| Setting | v1 value |
|---|---|
| Bind host | `127.0.0.1` |
| Port | `30141` unless `-p` / `PORT` |
| Clickable URL | `http://127.0.0.1:<port>` |
| WSL networking | `networkingMode=mirrored` and `hostAddressLoopback=true` |

On the audited Windows 11 + WSL 2.7.3 / Ubuntu 26.04 host, a WSL server bound
to `127.0.0.1` is reachable from the Windows browser at the same address. A
server bound only to the WSL `eth0` address is **not**. That is why v1 binds
loopback and does not "fix" WSL by switching to `0.0.0.0`.

If loopback is not forwarded (NAT default, `localhostForwarding=false`, or
sleep/resume breakage): print the URL, attempt the handoff, and fail loud. Do
not silently rebind all interfaces.

`next.config.ts` `allowedDevOrigins: ['192.168.*.*']` is for LAN cross-origin.
A Windows browser talking to `http://127.0.0.1:30141` is same-origin loopback
and does not need that list.

---

## 5. Browser handoff

One helper, used by `npm run web` and `pi-web`. No extra npm dependency.

### Detect WSL

Treat the process as WSL when any of these is true:

- `process.env.WSL_DISTRO_NAME` is non-empty
- `process.env.WSL_INTEROP` is non-empty
- `os.release()` lowercased contains `microsoft`

`process.platform` is `linux` in WSL. Do not use platform alone.

### Detect SSH

Skip open when `SSH_CONNECTION` or `SSH_TTY` is non-empty in the process
environment. Inherited from the launching shell is enough; do not read `.env`
for this (a project `.env` must not decide how the GUI is handed off).

### Open command

Never `cmd.exe /C start`. Same reason as desktop path-open: cmd parsing splits
legal characters. Never `xdg-open` when WSL is detected — that targets a Linux
desktop that is usually absent.

| Host | Command | Arguments |
|---|---|---|
| macOS | `open` | `[url]` |
| WSL | `powershell.exe` | `-NoProfile -Command Start-Process '<url>'` with PowerShell single-quoting (`'` → `''`) |
| Windows native | `powershell.exe` | same `Start-Process` form (optional in v1; cheap if the helper is shared) |
| Other Linux | `xdg-open` | `[url]` (not a v1 gate) |

Spawn detached, ignore stdio, unref. Wait only for the launcher process to
accept/reject the spawn, not for the browser window to stay open.

On WSL, `powershell.exe` is reached through Windows interop
(`/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe` is present on
the audited host). Prefer `powershell.exe` on `PATH`; if spawn ENOENT, print
the diagnostic and keep serving.

### When to open

Watch server stdout for Next's `Ready` (same as today's `bin/pi-web.js`). Open
once. A refresh of the already-open tab is the operator's job; do not reopen on
hot reload.

---

## 6. Trust boundary

v1 does not add authentication. The server is a local agent with tools.

Existing rules already cover a Windows browser on loopback:

- `isApiRequestHostAllowed` accepts `localhost`, `*.localhost`, and IP
  literals, including `127.0.0.1`.
- Origin must match Host when present; `sec-fetch-site: cross-site` is refused.
- Optional `PI_WEB_PASSWORD` Basic Auth is unchanged (`username` `pi`).
- `PI_WEB_HOSTNAME` / `PI_WEB_ALLOWED_HOSTS` remain the named-host allow-list.
  v1 does not need them for WSL or macOS.

Do not load this URL in the Tauri WebView. The WebView origin
`http://127.0.0.1:*/*` is granted native capabilities, including the desktop
API token. The web profile is a **browser** profile; pairing it with Tauri is a
different, later feature.

---

## 7. Sessions and home directory

| Launch | Store |
|---|---|
| WSL | that distro user's `~/.pi/agent` |
| macOS | that Mac user's `~/.pi/agent` |

Do not share the store over DrvFs. Auth, sessions, models, and extensions stay
on the OS that runs the tools. Re-auth on first WSL use is acceptable for v1.

Workspace paths should live on the same OS as the server (ext4 in the distro,
APFS on the Mac). `/mnt/c/...` as cwd is not forbidden, but it is slow and
case-insensitive; do not make it the documented default.

---

## 8. Implementation sketch

Keep the change small. Three files plus tests, no new runtime dependency.

| Piece | Role |
|---|---|
| `lib/browser-open.js` (or `.ts` compiled away — CJS is fine, `pi-web.js` is CJS) | `isWsl()`, `shouldOpenBrowser(env)`, `openBrowser(url)` returning a Promise that rejects with a short reason |
| `bin/pi-web.js` | Replace the `start` / `open` / `xdg-open` branch with the helper. Keep Ready detection. Print the canonical `127.0.0.1` URL, not the raw `-H` value when that value is a wildcard. |
| `scripts/web-dev.mjs` | Spawn `next dev -H 127.0.0.1 -p <port>` with the same Ready + handoff path. Forward extra args. |
| `package.json` | `"web": "node scripts/web-dev.mjs"` |
| `lib/browser-open.test.mjs` | Table-test WSL detection, SSH skip, quoted `Start-Process` command, macOS `open` argv. Do not spawn a real browser in CI. |

`bin/pi-web-options.js` already has `--no-open` and `PI_WEB_NO_OPEN`. Reuse it
from the dev wrapper.

Suggested shape of the PowerShell command (URL is an http(s) loopback URL we
constructed, not operator filesystem input, but still quote it):

```js
function powershellStartProcess(url) {
  const literal = `'${String(url).replace(/'/g, "''")}'`;
  return ["powershell.exe", ["-NoProfile", "-Command", `Start-Process ${literal}`]];
}
```

---

## 9. Platform notes

### WSL2

- Run from an ext4 checkout (`~/...`), not `/mnt/c`.
- Node 22+ inside the distro. Do not pick up Windows `node.exe` via interop
  PATH.
- First visit in Windows Edge/Chrome to `http://127.0.0.1:30141`.
- If the tab spins: check `.wslconfig` for mirrored + `hostAddressLoopback`,
  then `ss -ltn | grep 30141` inside WSL.
- `wslview` is **not** required. The audited host does not have it.

### macOS

- `open http://127.0.0.1:30141` is the entire handoff.
- Apple Silicon as in the README. No extra entitlements; this is a user-space
  Node server plus the default browser.
- Loopback bind avoids triggering local-network permission prompts that an
  all-interfaces bind can cause.

---

## 10. Validation gates (v1)

Must pass before calling the feature done. Manual is enough for the browser
window itself; detection/quoting is unit-tested.

**WSL**

1. `npm run web` from this repo on ext4 opens the Windows default browser at
   `http://127.0.0.1:30141`.
2. A prompt runs tools against a Linux cwd; `uname` inside bash is Linux.
3. `npm run web -- --no-open` prints the URL and does not open a window.
4. With `SSH_CONNECTION` set, no open is attempted.
5. Killing/removing `powershell.exe` from PATH leaves the server running and
   prints the manual-URL diagnostic.
6. Existing `npm run dev` still does not auto-open.

**macOS**

1. `npm run web` opens the default browser at `http://127.0.0.1:30141`.
2. `--no-open` and SSH skip behave as on WSL.
3. Bind is `127.0.0.1` (not `0.0.0.0`).

**Both**

- Unit tests for `isWsl` / argv construction.
- `npm test` and `node_modules/.bin/tsc --noEmit` stay green.
- No `next build` in the web-profile path.

---

## 11. Later (explicitly not v1)

- Native Windows `npm run web` as a supported, tested product surface.
- Linux desktop handoff quality.
- DSH-style tokenized URL / cookie fence if we ever bind beyond loopback.
- NAT-mode WSL helper (port proxy or documented `localhostForwarding`).
- Tauri Option A from [wsl2-feasibility.md](./wsl2-feasibility.md).
- Auto-opening on `npm run dev` (keep `dev` quiet; `web` is the handoff entry).

---

## 12. Reference: current gaps this spec closes

- `bin/pi-web.js` used `xdg-open` whenever `process.platform !== win32/darwin`.
  In WSL that does not open the Windows browser. Both `pi-web` and `npm run web`
  now go through `lib/browser-open.js`.
- `npm run dev` never opens a browser, so the WSL workflow was "print nothing
  special, hope the operator types localhost in Edge". `npm run web` is the
  handoff entry; `dev` stays quiet.
- [wsl2-feasibility.md](./wsl2-feasibility.md) Option C called this a spike and
  left it unspecified. This file is that specification.
