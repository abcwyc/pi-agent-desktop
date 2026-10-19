import { NextResponse } from "next/server";
import { invalidateModelsCache } from "@/lib/models-cache";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  CHAT_INSTRUCTIONS_MAX_CHARS,
  readChatSettings,
  validateChatSettingsPatch,
  writeChatSettings,
} from "@/lib/chat-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...readChatSettings(), instructionsMaxChars: CHAT_INSTRUCTIONS_MAX_CHARS });
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let patch;
  try {
    patch = validateChatSettingsPatch(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  try {
    const saved = writeChatSettings(patch);
    // The composer's default model for a new chat comes from the cached model list.
    invalidateModelsCache();
    return NextResponse.json({ ...saved, instructionsMaxChars: CHAT_INSTRUCTIONS_MAX_CHARS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
