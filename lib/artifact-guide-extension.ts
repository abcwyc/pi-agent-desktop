import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { isArtifactsPromptEnabled } from "./artifact-settings";

export const ARTIFACT_GUIDE_EXTENSION_NAME = "pi-web-artifacts";
export const ARTIFACT_GUIDE_SECTION = "artifacts";

// Tells the model the `:::artifact` syntax lib/artifacts.ts parses. Kept short
// because it is sent with every request; the "when not to" lines matter as
// much as the format, or every code answer turns into a panel.
export const ARTIFACT_GUIDE = `Replies are shown in Pi Web, which renders an artifact block in a side panel next to the chat. Use an artifact only when the user benefits from viewing or interacting with standalone content: a complete HTML page, app, game, visualization or dashboard; a React component; an SVG image; a Mermaid diagram; a diagram or chart that explains structure, flow or data (architecture, call flow, comparison); or a long self-contained document they will reuse. Do not use one for short snippets, explanations, answers that fit in the message, or changes to project files (edit those with tools).

Format (the inner code fence is required):
:::artifact{identifier="tip-calculator" type="html" title="Tip calculator"}
\`\`\`html
<!DOCTYPE html>
...
\`\`\`
:::

- type: html, react, svg, mermaid, markdown, or code (for code, put the language on the inner fence).
- react: one JSX/TSX module whose default export is the component, with no required props. Import React hooks from "react" and any npm package by name (loaded from esm.sh, e.g. lucide-react, recharts); no local or "@/..." imports. Style with Tailwind classes.
- To change an artifact, output the whole artifact again with the same identifier; it becomes a new version. Use a new identifier for unrelated content.
- HTML must be one complete file. It runs in a sandboxed frame with no access to this app, the user's files or cookies, and storage that resets on reload. Scripts and styles may load from public CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net) but can be unavailable offline.
- Colors: for diagrams, charts, dashboards and documents, do not hard-code them. Use the theme variables so the page matches the app in light and dark (games and branded pages may keep their own palette): --color-text-primary / -secondary / -tertiary; --color-background-primary / -secondary; --color-border-tertiary / -secondary / -primary; --color-text-info / -success / -warning / -danger with --color-background-info / ... tints; data series --color-series-1 to -6; fonts --font-sans, --font-mono. Leave the page background unset, and do not set the page text color.
- Diagrams (type html or svg): inline SVG with a viewBox and width="100%", nodes on a grid, one direction, arrows never across a box. The page defines the classes .t (14px text), .ts (12px secondary text), .th (14px heading), .box (neutral node), .arr (connector line), .leader (dashed guide). Color a node by wrapping its shapes and text in <g class="c-blue"> (also c-teal, c-amber, c-red, c-purple, c-gray).
- Interactive pages can call sendPrompt("text") from a click handler to put a follow-up question in the user's input box (for example a "Break down this step" button); never call it on load. The user reads and sends it.
- Keep commentary outside the block, usually one or two sentences; say what it shows, not what is in it.`;

/**
 * Adds the `<artifacts>` prompt section to every run of a normal Pi Web
 * session. The switch in Settings › General is read on each run, so turning
 * it off removes the section from the next prompt without a reload (the SDK
 * diffs sections and records the removal in the transcript).
 */
export function createArtifactGuideExtension(
  isEnabled: () => boolean = isArtifactsPromptEnabled,
): InlineExtension {
  return {
    name: ARTIFACT_GUIDE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        if (isEnabled()) event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION] = ARTIFACT_GUIDE;
        else delete event.systemPromptOptions.sections[ARTIFACT_GUIDE_SECTION];
        return undefined;
      });
    },
  };
}
