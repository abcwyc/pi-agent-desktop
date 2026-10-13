# Native theme — the fork's visual layer

[简体中文](native-theme.zh-CN.md)

This fork restyles pi-web as a native-feeling desktop app. All of that styling lives in
one fork-owned file, [`app/native-theme.css`](../app/native-theme.css), so that pulling a new
pi-web release never means re-doing the design. This page covers where each rule goes, what
the design is trying to achieve (so it can be restored after a merge), and what to check once
a merge lands.

## Where a rule goes

| File | Owner | Rule |
|---|---|---|
| `app/globals.css` | pi-web | **Byte-identical to upstream.** Never edit. |
| `app/settings.css` | pi-web | **Byte-identical to upstream.** Never edit. |
| `app/native-theme.css` | fork | Every fork style: tokens, overrides, new classes. |

`app/layout.tsx` imports `globals.css` → `settings.css` → `native-theme.css`, so a rule in the
native theme beats an upstream rule of equal specificity. In a component, the fork change is
limited to adding a `className` (and deleting the inline style it replaces). See
[ownership-boundaries.md](ownership-boundaries.md) for the general rules about shared files.

**Enforced.** [`scripts/upstream-css-baseline.test.mjs`](../scripts/upstream-css-baseline.test.mjs)
compares both upstream files against the hashes in `scripts/upstream-css-baseline.json`, which
belong to the last merged pi-web commit. After an upstream merge, the sync workflow runs
`node scripts/upstream-css-baseline.mjs update <upstream-ref>`. That command refuses to record
new hashes unless both files match upstream exactly, so it cannot bless a fork edit. For a
manual merge, run it yourself.

### Layout of `native-theme.css`

1. **Fork base layer** (top of the file, marked with `====` banners). These rules used to be
   edited into the two upstream files and moved out on 2026-09-26. They sit after both upstream
   files, so their overrides of upstream rules still win, but before the rest of the theme, so
   the theme still supersedes them. Placing them there kept the cascade exactly as it was: a
   computed-style comparison of every element across the main view, all five settings tabs, the
   file panel, forced resize/busy states, mobile width and dark mode found zero differences.
   - *New fork classes:* project tree and its context menu, empty-sidebar add button, session
     loading hint, conversation navigator, file-tree pane, column resize handles, settings
     entry menu, General-tab intro/updates/choice rows.
   - *Overrides of upstream rules:* `.panel-resize-handle::after` (1px line, softer tints),
     `.file-panel-expand-button` (borderless 28px chip), mobile `.right-panel-container`
     (`!important` pinning), `.skill-version-value` colour, settings dialog size, backdrop and
     radius, two-column General at ≥880px.

     To override a property that upstream sets and the fork simply *dropped*, reset it
     explicitly (`border-left: none`, `max-width: none`). A later rule cannot delete an earlier
     declaration.
2. **Tokens.** The neutral light/dark overrides exclude named palettes. Mist (soft sage),
   Rose and Pine keep upstream’s core colors; the native layer derives matching surfaces,
   separators and focus states from them. Pine uses dark elevation and native window chrome.
   `hooks/useTheme.ts` sets `data-theme` and the dark class; the desktop persists the palette
   name across server-port changes. System follows the OS scheme.
3. **Component sections**, roughly in DOM order: sidebar, topbar, popovers/modals, settings,
   composer, messages/markdown, file workbench, responsive shell. The file ends with a "final
   workbench pass" that must stay after the responsive rules.

Where a new rule goes: a fork-only class goes in the matching component section. An override
of an upstream rule goes in the component section when it is cosmetic. It goes in the base
layer when other theme rules need to beat it.

## Design intent

The reasons behind the visual choices. When a merge makes something look wrong, restore it to
the intent described here.

**Palette.** The canvas is warm off-white (`--bg: #f7f7f5`), and pure white is reserved for
controls and elevated surfaces (`--surface`). The accent is near-black (`#1d1d1f`, near-white
in dark mode) rather than a brand colour. Emphasis comes from contrast, not hue. `--text-dim`
stays at a value that clears 3:1 contrast because it carries real labels; inside the sidebar
(light mode) it is darkened to clear 4.5:1, and `--text-meta` (10px message footnotes) does too.
The two exceptions to the near-black accent are text selection and keyboard focus rings: they
use the system `AccentColor` (`--selection`, `--focus-ring`, behind an `@supports` query that
also requires `color-mix`) so they read as native. Browsers without it keep the neutral values.

**Palette character.** Mist uses rounded controls, mist-line icons and a soft dissolve;
Rose uses fuller corners, a flower that unfolds on interaction, and a reveal anchored to
the selected option; Pine uses tighter corners, a filled tree silhouette and a quick fade.
The preview icons animate once on selection, hover or keyboard focus, never continuously.
Reduced motion disables these movements and the theme reveal; desktop keeps its safe
instant-switch fallback. Functional icons retain their familiar meanings.

**Shape and motion.** Radii come from `--radius-sm/md/lg/xl` (6/8/12/16px). Controls are
`--control-height-sm` 28px or `--control-height` 32px. Elevation uses the four
`--shadow-*` levels. Easing is `--ease-native`.

**One chip language.** Every toolbar-ish control is a quiet 28×28 chip with a 7px radius.
It shows `--bg-hover` when hovered and `--bg-selected` when pinned on. The pinned state is
deliberately one step stronger than hover, so "on" is never mistaken for the pointer resting on
the control. This applies to sidebar chrome buttons, the topbar actions, the panel toggle, the
right-panel header row and the file-panel expand button.

**Sidebar.** It runs the full window height. On macOS its header hosts the traffic lights.
- Header rows (New chat / folder / branch) are flat and full-width, Claude-Desktop style.
- Refresh stays hidden until you hover the folder row.
- Projects render as a Codex-style tree. Session rows are 28px, matching the view-switcher
  tabs. Project and session rows share one inset pill (10px margin, 8px radius); a project row
  is 30px (34px on touch) and has no disclosure chevron, because its folder glyph already shows
  open / closed. Session titles share the project name's left edge, and a plain row keeps its
  hidden chat glyph in layout so running / unread indicators land in the same slot.
- The section label ("Projects") is sentence case, 12px semibold, not tracked capitals; row
  titles are Regular (400) even when selected.
- A selected row has no accent ring: its border blends into the selected background.
- A row's "…" menu is always visible on touch devices.

**Topbar.** There is one right-aligned toolbar group (history / branches / more). The "More"
panels (session stats, system prompt, agents, tools) are opaque and share one surface,
because they sit over chat content. Dropdowns align with the main column.

**Right panel / file workbench.** The header is one chrome row, and its strip keeps the
topbar's background, so the row reads as one bar whether the panel is open or closed. A tab's
close button appears only on the hovered or active tab. Resize handles are a 1px line on the
existing border: hover tints it and dragging darkens it, and neither adds a second pixel.

**Settings.** Settings is an in-window preferences sheet, not a page. It is 1040×700 at most
and clamped with `min()` on small windows. The scrim is light but still makes the app read as
inactive. General splits into two columns at ≥880px.

**Chat.** The composer aligns with the message column. Markdown tables wrap within the panel
instead of scrolling (this reverts upstream #650). While a run is busy, fork/navigate actions
on user messages are hidden with CSS (`data-session-busy`), not props, so message memoization
survives.

## After an upstream merge

1. `npm test`. A failing `upstream-css-baseline` test means fork rules crept back into an
   upstream file: move them here and restore the file. `fork-extractions.test.mjs` catches a
   dropped `native-theme.css` import or a reverted component.
2. Any new upstream UI renders with upstream defaults. Attach classNames and style it here.
3. Visually check: sidebar (tree, hover/selected rows, search), topbar and More panels,
   composer, a long chat with code/tables, the file panel (tabs, expand, resize), every
   settings tab, light and dark, and a ≤640px window.
