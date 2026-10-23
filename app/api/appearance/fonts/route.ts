import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readFontPreferences, writeFontPreferences } from "@/lib/font-settings";
import { isFontPreferences } from "@/lib/font-preferences";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ fonts: readFontPreferences() });
  } catch {
    return NextResponse.json({ error: "Could not read font settings" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const fonts = body && typeof body === "object" && "fonts" in body ? body.fonts : undefined;
  if (!isFontPreferences(fonts)) return NextResponse.json({ error: "Invalid fonts" }, { status: 400 });
  try {
    writeFontPreferences(fonts);
    return NextResponse.json({ fonts: { ui: fonts.ui, mono: fonts.mono } });
  } catch {
    return NextResponse.json({ error: "Could not save font settings" }, { status: 500 });
  }
}
