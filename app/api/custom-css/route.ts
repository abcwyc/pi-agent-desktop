import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isApiRequestAllowed } from "@/lib/request-security";

/**
 * Serve an optional user-provided stylesheet so the UI (fonts, colors,
 * sizes) can be customized without rebuilding the app.
 *
 * Path: `<agentDir>/desktop/custom.css` (normally ~/.pi/agent/desktop/custom.css).
 * Returns an empty 200 when the file does not exist, so the <link> in the
 * layout never logs a missing-stylesheet error. Served with no-store so
 * edits show up on the next reload without restarting the app.
 */
export async function GET() {
  const filePath = join(getAgentDir(), "desktop", "custom.css");
  let css = "";
  try {
    css = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`custom-css: failed to read ${filePath}:`, error);
    }
  }
  return new NextResponse(css, {
    status: 200,
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Starter content written when custom.css is first created. */
const STARTER_CSS = `/* Pi Agent custom stylesheet.
 * Loaded last, so these rules win the cascade.
 * Reload the window (Ctrl+R / Cmd+R) to apply edits.
 *
 * Font variables used by the app:
 *   --font-ui       chat and interface text
 *   --font-display  headings
 *   --font-mono     code blocks and tool output
 *
 * Example:
 * :root {
 *   --font-ui: "Inter", "Segoe UI", -apple-system, sans-serif;
 *   --font-mono: "Cascadia Code", "JetBrains Mono", monospace;
 * }
 * .markdown-body { font-size: 15px; }
 */
`;

/**
 * Ensure the user stylesheet exists (creating a commented starter file on
 * first use) and return its absolute path so the client can open it in the
 * user's editor. Only loopback/allowed-origin requests may create files.
 */
export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const filePath = join(getAgentDir(), "desktop", "custom.css");
  let created = false;
  try {
    await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`custom-css: failed to read ${filePath}:`, error);
      return NextResponse.json({ error: "Failed to read custom.css" }, { status: 500 });
    }
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, STARTER_CSS, "utf8");
      created = true;
    } catch (writeError) {
      console.error(`custom-css: failed to create ${filePath}:`, writeError);
      return NextResponse.json({ error: "Failed to create custom.css" }, { status: 500 });
    }
  }

  return NextResponse.json({ path: filePath, created });
}
