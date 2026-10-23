import { NextResponse } from "next/server";
import { isDesktopApiRequestAllowed } from "@/lib/desktop-api-auth";
import { listSystemFonts } from "@/lib/system-fonts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isDesktopApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
  }
  try {
    return NextResponse.json({ fonts: await listSystemFonts() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not read installed fonts" }, { status: 503 });
  }
}
