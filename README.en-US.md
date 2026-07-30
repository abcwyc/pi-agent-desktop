

# Pi Agent

`pi-agent-desktop` is a native AI Agent desktop application for macOS and Windows. It packages the Agent capabilities of [pi](https://github.com/earendil-works/pi) into a standalone, installable App.

## Key Features

- Browse and resume historical Pi sessions by project, without digging through terminal history or `.jsonl` files.
- Interact with the Agent in real-time within a desktop window, viewing thoughts, tool calls, context usage, costs, and compression status.
- Branch from historical messages or fork a session into an independent one.
- Manage models, OAuth/API keys, custom model configurations, Skills, and Plugins.
- Switch Git worktrees in the sidebar and browse project files.
- Preview source code, Diffs, Markdown, images, audio, PDFs, and DOCX files.
- Supports dark mode, automatic session naming, completion chimes, and state recovery.
- Checks for stable GitHub Releases of the three constituent projects weekly and notifies users when updates are available.
- Install a complete, signed new version of Pi Agent with a single upgrade button and automatically restart.

![Pi Agent Light Mode Interface](./docs/screenshots/pi-agent-light@2x.png)

![Pi Agent Dark Mode Interface](./docs/screenshots/pi-agent-dark@2x.png)

**[⬇️ Download Pi Agent (macOS / Windows)](https://github.com/abcwyc/pi-agent-desktop/releases)**

Repository: [abcwyc/pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop)

## Installation & Usage

### Installing the Desktop App

Release builds are available for download from [GitHub Releases](https://github.com/abcwyc/pi-agent-desktop/releases):

- Apple Silicon Mac: Download `aarch64.dmg`, open it, and drag the App into `Applications`. Official Releases do not build Intel Mac versions.
- Windows x64: Download the installer ending with `x64-setup.exe` and run it. The installer will install Microsoft WebView2 if needed.

Official Releases support Apple Silicon Macs running macOS 11 or later, and Windows 10/11 x64. The desktop bundle includes the Next.js service, Node.js runtime, and current Pi SDK required to run Pi Agent. The local service starts automatically upon opening the App, eliminating the need for users to open a separate terminal, install Node.js, or manually start a web server.

> After installing Pi Agent, you can use the Pi Agent features directly within the App; however, it does not install the `pi` command globally on your system. If you also need to use the Pi CLI in your terminal, please follow the instructions in the [pi project](https://github.com/earendil-works/pi) to install it separately.

Before enabling signed automatic updates for the first time, older versions without an updater require a manual installation of the new signed App once. After that, updates can be completed directly from the settings.

### Using Existing Pi Data

Pi Agent reads the local Pi data directory by default:

```text
~/.pi/agent/
```

Sessions are typically stored at:

```text
~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
```

If Pi has already been used on your computer, you can continue browsing existing sessions, models, and authentication configurations after installing the App. You can point to another Pi Agent data directory using `PI_CODING_AGENT_DIR`.

Model keys and session data remain on the user's computer; the file browsing API only allows access to the current session, selected project, and explicitly authorized working directories.

## Version Checking & Upgrades

Pi Agent checks for the latest stable Releases of the following repositories at most once every seven days:

- `abcwyc/pi-agent-desktop`
- `earendil-works/pi`
- `agegr/pi-web`

Versioning and upgrade rules are as follows:

1. Once a Release exists for `pi-agent-desktop`, the latest stable Release serves as the upgrade source.
2. If any of the three components falls behind, the unified upgrade button in settings will be enabled.
3. If multiple components require updates, the release automation synchronizes and verifies them in the order `pi → pi-web → pi-agent-desktop`.
4. On the user side, individual JavaScript packages within the installed App are not modified; instead, a complete, signed App containing the latest versions of all three components is downloaded.
5. Upon installation completion, the App automatically restarts, bringing all three components into a single, verified release state simultaneously.

This approach maintains component consistency across the desktop package and prevents runtime incompatibilities that could arise from independently replacing `pi` or `pi-web`.

If a newer upstream version has been detected but a signed `pi-agent-desktop` Release containing it has not yet been published, the settings page will indicate that no signed full package is currently available for installation; the App will not fall back to downloading unsigned files or partially overwriting dependencies.

For more detailed synchronization, signing, and Release configurations, see [Desktop Updates & Release Guide](./docs/desktop-updates.md).

## HTTP Proxy

Pi Agent's server-side model and API requests support standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables. For example, when starting the development service from the terminal:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npm run dev
```

## Local Development

### Prerequisites

- macOS 11+ (Apple Silicon) or Windows 10/11 x64
- Node.js 22 (recommended)
- npm
- Rust 1.85+
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2

### Starting the Web Development Server

```bash
npm install
npm run dev
```

The development server runs on [http://localhost:30141](http://localhost:30141).

Do not run `next build` or `npm run build` during daily development. These commands write to `.next/`, which may interfere with the running development server; official builds are handled by desktop preparation scripts or CI.

### Starting Desktop Development Mode

```bash
npm run desktop:dev
```

This command starts the existing Next.js development server and opens the page in a native Tauri window, without generating an installer.

### Common Checks

```bash
# Node tests (identical to CI sync gates, includes components/ tests)
npm test

# TypeScript
node_modules/.bin/tsc --noEmit

# ESLint and brand protection tests
npm run lint

# Drift from the pi-web upstream: distinguishes between "style" and "structural" changes
npm run drift

# Rust/Tauri
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# Verify that packaged components match the latest stable Release
npm run release:verify
```

`release:verify` accesses GitHub and requires the bundled `pi` and `pi-web` to exactly match their respective latest stable Releases, while also checking that the component manifest matches the actual dependencies.

## Desktop Packaging

```bash
npm run desktop:build
```

The desktop build process will:

1. Generate a Next.js standalone service in an isolated directory.
2. Package the Node.js runtime for the current architecture.
3. Bundle the service and runtime as Tauri Resources into the App.
4. Generate `.app`, `.dmg`, and updater artifacts on Apple Silicon Mac; generate NSIS `-setup.exe` and updater artifacts on Windows x64.

Local builds do not register a production updater by default and cannot receive official updates. Official Releases must inject the updater public key via GitHub Actions and sign it with the corresponding private key.

## Upstream Sync & Releases

The repository contains two linked automated workflows:

- [`component-updates.yml`](./.github/workflows/component-updates.yml): Checks for stable Releases of `pi` and `pi-web` daily. Upon finding a new version, it **first** intersects the upstream change set with the "upstream files modified in this repository" recorded in [`scripts/fork-ownership.json`](./scripts/fork-ownership.json), then merges the Tag, updates dependencies and the component manifest, and runs full gates (`npm test`, `tsc`, `lint`, actual standalone build).
  - Empty intersection → commits directly to `main` and triggers a release;
  - Hits high/medium risk files → pushes a `sync/pi-web-<tag>` branch and opens a PR with a boundary report, **without** triggering a release. Merging this PR will trigger the release.
- [`release.yml`](./.github/workflows/release.yml): Upon explicit trigger from the component sync workflow, sequentially builds Apple Silicon (`aarch64`) DMG and Windows x64 NSIS `-setup.exe`, without building Intel Mac versions. The Release remains in draft status until the updater signature files, `latest.json`, and component manifest for both platforms are fully uploaded —— the `manifest` job depends on the **entire** build matrix, so failure on any platform prevents it from going live. Build failures will create/update a `release-failure` Issue.

Upstream synchronization uses Git merging, so Pi Agent branding, settings entry points, and upgrade logic maintained in this repository are preserved as local modifications. Merge conflicts will halt the workflow —— this is a safe failure mode. The real danger is **conflict-free but semantically incorrect** merges: the upstream changes an area this repository also modified, Git cleanly merges it, and tests pass green. The boundary intersection above is designed specifically to catch this; rules are detailed in [Ownership Boundaries Guide](./docs/ownership-boundaries.md).

Sync failures will automatically create/update a `component-sync-failure` Issue, preventing silent backlogs.

The following must be configured before official release:

- Tauri updater public/private keys;
- Apple Developer ID signing and notarization required for distribution to external users;
- Authenticode code signing certificate is recommended for distribution to Windows users; unsigned `.exe` files may trigger SmartScreen warnings.

## Project Structure

```text
app/
  api/                  Next.js API: Agent, sessions, models, files, and update checks
components/             Pages, chat, sidebar, settings, and version reminders
hooks/                  Client state for session streaming, audio, drag-and-drop, themes, etc.
lib/                    AgentSession, HTTP proxy, session reading, file security, and upgrade logic
scripts/                Desktop packaging, component version sync, and release verification scripts
src-tauri/
  capabilities/         Tauri permission configuration
  resources/            Desktop resources and component version manifest
  src/                   Desktop windows, local service, and updater registration
.github/workflows/      Daily component sync and desktop release automation
instrumentation.ts     Next.js server-side HTTP proxy initialization
```

## Related Documentation

- [Ownership Boundaries Guide](./docs/ownership-boundaries.md) — Division of labor with `pi-web` upstream, rules for modifying shared files, and logic for automatic sync
- [Desktop Updates & Release Guide](./docs/desktop-updates.md)
- [Git Worktree Usage Guide](./docs/worktrees.zh-CN.md)
- [Pi Session & Project Architecture Guide](./AGENTS.md)

## Attribution & License

The desktop integration for Pi Agent is provided by `pi-agent-desktop`, with core capabilities and the web interface sourced from [earendil-works/pi](https://github.com/earendil-works/pi) and [agegr/pi-web](https://github.com/agegr/pi-web) respectively. Thanks to these projects and their contributors.

The code in this repository's root directory follows the MIT License in [`LICENSE`](./LICENSE). The code and dependencies of the three constituent projects are also governed by their respective repository licenses; please retain corresponding copyright and license notices when copying, modifying, or redistributing.
