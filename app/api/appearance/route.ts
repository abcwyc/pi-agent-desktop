import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readBackgroundPreference, writeBackgroundPreference } from "@/lib/background-settings";
import { isBackgroundPreference } from "@/lib/backgrounds";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ background: readBackgroundPreference() });
  } catch {
    return NextResponse.json({ error: "Could not read appearance settings" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const background = body && typeof body === "object" && "background" in body ? body.background : undefined;
  if (!isBackgroundPreference(background)) return NextResponse.json({ error: "Invalid background" }, { status: 400 });
  try {
    writeBackgroundPreference(background);
    return NextResponse.json({ background });
  } catch {
    return NextResponse.json({ error: "Could not save appearance settings" }, { status: 500 });
  }
}
