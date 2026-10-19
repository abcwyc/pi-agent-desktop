import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  CHAT_ATTACHMENT_EXTRACT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILE_BYTES,
} from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plain text of a Word document attached to a chat. The browser sends the file body as-is;
 * nothing is written to disk and no path is involved, so the chat's "no file access" holds.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > CHAT_ATTACHMENT_EXTRACT_MAX_BYTES) {
    return NextResponse.json({ error: "too-large" }, { status: 413 });
  }
  try {
    const buffer = Buffer.from(await req.arrayBuffer());
    if (buffer.length === 0 || buffer.length > CHAT_ATTACHMENT_EXTRACT_MAX_BYTES) {
      return NextResponse.json({ error: buffer.length === 0 ? "not-text" : "too-large" }, { status: buffer.length === 0 ? 400 : 413 });
    }
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    const text = value.replace(/\r\n?/g, "\n").trim();
    if (!text) return NextResponse.json({ error: "not-text" }, { status: 422 });
    if (Buffer.byteLength(text, "utf8") > CHAT_ATTACHMENT_MAX_FILE_BYTES) {
      return NextResponse.json({ error: "too-large" }, { status: 413 });
    }
    return NextResponse.json({ text });
  } catch {
    return NextResponse.json({ error: "not-text" }, { status: 422 });
  }
}
