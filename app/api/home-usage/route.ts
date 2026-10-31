import { NextResponse } from "next/server";
import { listAllSessions, getSessionListVersion } from "@/lib/session-reader";
import { homeUsageRange, type HomeUsage, type HomeUsageRange } from "@/lib/home-usage";
import { readHomeUsage } from "@/lib/home-usage-reader";

export const dynamic = "force-dynamic";

declare global {
  var __piHomeUsageCache: Map<HomeUsageRange, { at: number; version: number; value: Promise<HomeUsage> }> | undefined;
}

export async function GET(request: Request) {
  let range: HomeUsageRange | null;
  try {
    range = homeUsageRange(new URL(request.url).searchParams.get("range"));
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!range) return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  const cache = globalThis.__piHomeUsageCache ??= new Map();
  const version = getSessionListVersion();
  let entry = cache.get(range);
  if (!entry || entry.version !== version || Date.now() - entry.at > 60000) {
    const value = listAllSessions().then((sessions) => readHomeUsage(sessions.filter((session) => !session.transient), range));
    entry = { at: Date.now(), version, value };
    cache.set(range, entry);
  }
  try {
    return NextResponse.json(await entry.value, { headers: { "Cache-Control": "no-store" } });
  } catch {
    if (cache.get(range) === entry) cache.delete(range);
    return NextResponse.json({ error: "Could not read local usage" }, { status: 500 });
  }
}
