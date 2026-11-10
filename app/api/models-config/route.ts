import { NextResponse } from "next/server";
import { ModelsConfigReadError, readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { mergeStoredLiteralApiKeys, redactModelsJson } from "@/lib/models-config-redaction";
import { ContextWindowError, normalizeContextWindowOverrides } from "@/lib/model-context";
import { checkProviderEntries, ProviderEntryError } from "@/lib/model-provider-check";
import { checkImageMaxBytes, ImageMaxBytesError } from "@/lib/model-image-limits";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Literal apiKey values never leave the server; shell/env references and
    // every other field are configuration the editor needs to see.
    return NextResponse.json(redactModelsJson(readModelsConfig()));
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const existing = readModelsConfig();
    const incomingProviders = (body.providers ?? {}) as Record<string, Record<string, unknown>>;
    const existingProviders = (existing.providers ?? {}) as Record<string, Record<string, unknown>>;
    // The client never sees stored literal apiKeys (GET redacts them), so an
    // incoming provider that omits the field must keep the stored value while
    // the user edits unrelated settings. An explicit apiKey (even "") wins.
    // Context-window overrides are checked and normalized as upstream does (Settings › Models).
    const config = normalizeContextWindowOverrides({
      ...body,
      providers: mergeStoredLiteralApiKeys(incomingProviders, existingProviders),
    });
    checkProviderEntries(config);
    checkImageMaxBytes(config);
    writeModelsConfig(config);
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof ContextWindowError || error instanceof ProviderEntryError || error instanceof ImageMaxBytesError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
