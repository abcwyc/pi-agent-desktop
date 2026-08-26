import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { invalidateModelsCache } from "@/lib/models-cache";
import { mergeStoredLiteralApiKeys, redactModelsJson } from "@/lib/models-config-redaction";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { providers: {} };
  }
}

function writeModelsJson(data: Record<string, unknown>): void {
  const path = getModelsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(data, null, 2));
}

export async function GET() {
  // Literal apiKey values never leave the server; shell/env references and
  // every other field are configuration the editor needs to see.
  return NextResponse.json(redactModelsJson(readModelsJson()));
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const existing = readModelsJson();
    const incomingProviders = (body.providers ?? {}) as Record<string, Record<string, unknown>>;
    const existingProviders = (existing.providers ?? {}) as Record<string, Record<string, unknown>>;
    // The client never sees stored literal apiKeys (GET redacts them), so an
    // incoming provider that omits the field must keep the stored value while
    // the user edits unrelated settings. An explicit apiKey (even "") wins.
    writeModelsJson({
      ...body,
      providers: mergeStoredLiteralApiKeys(incomingProviders, existingProviders),
    });
    invalidateModelsCache();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
