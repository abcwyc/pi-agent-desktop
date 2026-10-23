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
2. **Tokens.** `:root` holds the light palette and `html.dark` the dark one. `hooks/useTheme.ts`
   toggles the class, following the OS scheme until the user picks a theme.
3. **Component sections**, roughly in DOM order: sidebar, topbar, popovers/modals, settings,
   composer, messages/markdown, file workbench, responsive shell. The file ends with a "final
   workbench pass" that must stay after the responsive rules.

Where a new rule goes: a fork-only class goes in the matching component section. An override
of an upstream rule goes in the component section when it is cosmetic. It goes in the base
layer when other theme rules need to beat it.

## Design intent

The reasons behind the visual choices. When a merge makes something look wrong, restore it to
the intent described here.

**Palette.** The palette uses Pi's existing semantic tokens; attribution and its
MIT license are retained in [third-party notices](../public/THIRD_PARTY_NOTICES.txt).
Settings › Appearance separates light/dark/system
mode from five background choices: Petal (`rex`, default), Mist, Meadow, Dusk and Plain.
The sidebar/canvas and Settings chrome share `--canvas-background`; reading surfaces stay white in light
mode and graphite `#232328` in dark mode. Popovers are opaque white / `#232327`.
The blue `#3b6cf6` / `#6b93ff` is shared by selection pills, default stars,
settings switches/sliders, text selection and focus. Primary action fills retain the
neutral foreground/background pair. The semantic gray text is slightly darkened in light mode
where needed: ordinary labels and metadata target 4.5:1, dim labels 3:1, and sidebar
labels 4.5:1 on the wash. Do not use faint decorative gray on small labels.
Colors stay in `native-theme.css`; the 8px choice inset, 4px row gap, fonts and composer
geometry are preserved. Thumbnail cards use the same `--wash-*` stops as the canvas.
The background is cached in `pi-background` before paint and persisted through
`/api/appearance` to Pi Web's own settings file. This survives changing desktop server
ports. Writes are serialized and stale startup reads cannot undo a newer selection.
`node e2e/appearance.mjs` covers all washes, themes, widths, keyboard use and persistence.

**Shape and motion.** Radii come from `--radius-sm/md/lg/xl` (6/8/12/16px). Controls are
`--control-height-sm` 28px or `--control-height` 32px. Elevation uses the four
`--shadow-*` levels. Easing is `--ease-native`.

**Settings choices.** Config sidebars (Agents, Models, Skills, Plugins and MCP) reuse
the 8px choice inset, 4px row gap and 5px row radius. Selected and hovered neighbors
must remain separate; hovering the selected row must preserve its selected fill.
Segmented controls (mode, language, send shortcut, Diff, scope and file/artifact view mode) share `--segment-*`:
4px inset and gap (both reference the settings row gap), 5px inner / 9px outer corners,
and a quiet raised selected surface.
Their normal height is 32px (24px for small scope controls); coarse pointers retain
44px targets. Keep geometry in this shared rule, not section-specific overrides.
The tool definitions list also uses the shared 4px row gap.
`node e2e/settings-controls.mjs` measures the seven Settings sections, file view switch
and tool definitions with isolated data in both themes at 1280/390/320px, including hover and focus.

**Composer alignment.** The attach icon is an SVG. Its center follows the first text
line, including the placeholder, at every supported font size. Text padding and icon
position derive from `--composer-line-height` and `--composer-send-size`; do not nudge
the icon by a fixed pixel offset. Send stays bottom-aligned with the card's arc.
`e2e/composer-geometry.mjs` checks empty, single-line and multi-line drafts at 12–24px.

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
The actions and file-panel toggle sit beside the Windows/Linux window controls with
a fixed 12px gap. Only the first trailing group takes an auto margin; competing auto
margins would split the available space and leave the actions floating mid-bar.

**Menus.** UI consistency is mandatory. Desktop popups always use the same app-themed
DOM menus as the browser; build flags must not switch application menus to system styling.
Settings, More, project menus and composer selectors share `.app-menu`: an opaque
theme surface, 14px outer corners, 6px inset, 8px row corners and 4px between flat
choices (`--menu-row-gap`). Space the whole row, including rows with default stars
or worktree actions. Grid/flex choice groups use `.app-menu-items` to apply the same
gap without stacking margins or shifting columns. Tool presets show
their description below the name; selected rows retain a check and a muted fill.
Simple action/option menus support arrows, Home/End, Escape and focus restoration.
Form option pickers use `AppSelect` (Radix Select); editable suggestions use
`AppCombobox`. Raw `select`/`datalist` popups are prohibited. Shared tokens define
geometry and interaction states; `scripts/ui-menu-consistency.test.mjs` checks every
component for regressions. References, inventory and verification: [menu audit](ui-menu-audit.md).

**Right panel / file workbench.** The header is one chrome row, and its strip keeps the
topbar's background, so the row reads as one bar whether the panel is open or closed. A tab's
close button appears only on the hovered or active tab. Resize handles are a 1px line on the
existing border: hover tints it and dragging darkens it, and neither adds a second pixel.

**Settings.** Settings is an in-window preferences sheet, not a page. It is 1040×700 at most
and clamped with `min()` on small windows. The scrim is light but still makes the app read as
inactive. General splits into two columns at ≥880px. The dialog follows the host platform through
`<html data-platform>` (`lib/ui-platform.ts`, set when it mounts, in the browser too): macOS
gets a centered preferences toolbar (icon over label, gray tile for the selection, no title),
Windows and Linux get a left navigation pane with the content as a card under a title bar
(≥900px; narrower windows keep the top tabs), with a Fluent switch and red corner close on
Windows and a GNOME round close on Linux. Switches and sliders use the shared blue
when on; buttons keep the neutral accent. Phone and ≤640px picker layouts are untouched.
⌘, / Ctrl+, opens it at the last section.

**Chat.** The composer aligns with the message column. Markdown tables wrap within the panel
instead of scrolling (this reverts upstream #650). While a run is busy, fork/navigate actions
on user messages are hidden with CSS (`data-session-busy`), not props, so message memoization
survives.

The circular send button and the composer's bottom-right corner share a center. Keep the
right and bottom insets equal; the outer radius is the button radius plus that inset and
the border width. The card grows upward for multiline drafts while the button stays at the
bottom. Touch sizing changes the shared `--composer-send-size`, so both radii update together.
`e2e/composer-geometry.mjs` checks newlines, wrapping, the height limit, and shrinking back.

## After an upstream merge

1. `npm test`. A failing `upstream-css-baseline` test means fork rules crept back into an
   upstream file: move them here and restore the file. `fork-extractions.test.mjs` catches a
   dropped `native-theme.css` import or a reverted component.
2. Any new upstream UI renders with upstream defaults. Attach classNames and style it here.
3. Visually check: sidebar (tree, hover/selected rows, search), topbar and More panels,
   composer, a long chat with code/tables, the file panel (tabs, expand, resize), every
   settings tab, light and dark, and a ≤640px window.
