import { NextResponse } from "next/server";
import { pluginSearchParams, searchPlugins } from "@/lib/plugin-discovery";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let params;
  try {
    params = pluginSearchParams(new URL(req.url).searchParams);
  } catch {
    return NextResponse.json({ error: "Invalid search parameters" }, { status: 400 });
  }
  try {
    return NextResponse.json(await searchPlugins(params.query, params.offset));
  } catch {
    return NextResponse.json({ error: "Package registry is unavailable" }, { status: 502 });
  }
}
