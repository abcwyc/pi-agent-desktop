# CI and browser regression tests

Adapted from @Nuctori's CI/E2E proposal in #617 and #599. The performance
scanner, reverse reader, sidebar changes, and timing benchmarks are not included.

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

The script starts and stops its own Turbopack dev server on an available
loopback port. Run it in a checkout without an active dev server; Next.js
shares `.next/dev/lock` within a checkout. All fixtures are created before
startup in a temporary `PI_CODING_AGENT_DIR` and removed on completion.
No model credentials or existing Pi sessions are needed.

CI runs lint, type checking, and unit tests in one job. A separate job builds
the application in a clean checkout and runs the same browser tests with
`E2E_SERVER_MODE=start` against `next start`. Do not build in a checkout used
for development.

Coverage:

- `node e2e/terminal-settings.mjs` checks the General terminal picker with Windows
  and macOS lists, light/dark, English/Chinese, narrow layouts, keyboard navigation,
  persistence, unavailable shells and load/save errors. No PTY starts on selection.
- `node e2e/appearance.mjs` checks ten backgrounds in light/dark, five-column
  desktop rows, narrow wrapping, preview/canvas agreement, new-wash text contrast,
  keyboard selection, persistence and save races/errors.
- `node e2e/sidebar-menu-placement.mjs` opens the session and project "…" menus
  on rows near the bottom of the window and checks that they flip upward, stay
  inside the viewport and keep their last entry reachable, in both themes and
  languages.
- `node e2e/title-feedback.mjs` exercises the real AppShell with isolated sessions
  and synthetic title responses: progress after menu dismissal, duplicate guards,
  persistent 401 feedback, Models navigation, retry, successful header/sidebar
  refresh and results arriving after a session switch. Optional
  `TITLE_FEEDBACK_RESOURCES=src-tauri/resources` runs against packaged resources.
- Terminal renderer cold/preloaded opening, missing-session reconnect, light/dark
  colors and fitting below a workspace toolbar (`node e2e/terminal-theme.mjs`).
- Session deletion keeps sidebar rows stable and uses the shared confirmation
  dialog. `node e2e/session-delete.mjs` covers menu/keyboard/Shift entry points,
  light/dark layouts, full names, error/retry, focus and the chat-folder checkbox.
  It also measures the more-action highlight in hover/focus/open states across
  three fonts: 4px top/bottom/trailing clearance, centered dots and a 28px hit area.
- A 5,000-message session opens with exactly the last 50 entries, bounded
  detail/context responses, and no browser errors.
- Desktop and mobile scrolling load two consecutive older pages. Each response
  has the expected IDs, no gaps or duplicates, and the messages appear once in
  the chat. A small session checks pagination through the root.
- Branch context follows the selected leaf and excludes the other branch.
- Conversation navigation hides in narrow chat columns and with the workspace
  open, restores on wide layouts, and still supports keyboard jumps. The full
  application test returns to its original viewport after these checks.
- Markdown, code blocks, and real tool-call/tool-result blocks render.
- Chat width and font size persist, existing drafts resize, and short settings
  panels keep every language option reachable on desktop and mobile.
- Interface/chat and monospace font lists and weights apply live, survive
  refresh, sync between tabs and reset independently without changing width or
  font size. Headings and Markdown emphasis retain their weights.
- Unknown sessions and paths outside the fixture project are rejected.
- A local extension checks dialog keyboard navigation, Esc cancellation,
  collapse/expand draft preservation, countdown display, and server-side expiry.
- The MCP manager renders configured servers in a master-detail layout and
  never shows credential-bearing HTTP query strings.

Model prompts, live model streaming, and agent execution are outside this suite.
Failures save a screenshot, Playwright trace, and server log under
`test-results/e2e/`; CI uploads that directory. Open a trace with
`npx playwright show-trace test-results/e2e/trace.zip`.
