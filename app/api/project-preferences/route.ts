import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { changeProjectPreferences, readProjectPreferences, type ProjectPreferenceChange } from "@/lib/project-preferences";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return NextResponse.json(readProjectPreferences()); }
  catch { return NextResponse.json({ error: "Unable to read project preferences" }, { status: 500 }); }
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!validChange(body)) return NextResponse.json({ error: "Invalid project preference change" }, { status: 400 });
  try { return NextResponse.json(changeProjectPreferences(body)); }
  catch { return NextResponse.json({ error: "Unable to save project preferences" }, { status: 500 }); }
}
function validChange(body: unknown): body is ProjectPreferenceChange {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.action === "migrate") return !!b.names && typeof b.names === "object" && !Array.isArray(b.names)
    && Object.values(b.names).every(n => typeof n === "string")
    && Array.isArray(b.archived) && b.archived.every(p => typeof p === "string");
  return typeof b.path === "string" && !!b.path.trim() &&
    ((b.action === "rename" && typeof b.name === "string") || b.action === "archive" || b.action === "restore");
}
