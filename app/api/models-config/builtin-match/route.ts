import { NextResponse } from "next/server";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { findBuiltinMatch, type CatalogProvider } from "@/lib/builtin-model-match";

export const dynamic = "force-dynamic";

/**
 * GET ?baseUrl=&modelId= — the built-in providers serving this endpoint and, when pi
 * lists the model there, the settings pi ships for it (lib/builtin-model-match.ts).
 * Reads pi's bundled catalog only: no network, no credentials.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const baseUrl = (searchParams.get("baseUrl") ?? "").slice(0, 500);
  const modelId = (searchParams.get("modelId") ?? "").slice(0, 200);
  try {
    const catalog = builtinProviders() as unknown as readonly CatalogProvider[];
    return NextResponse.json(findBuiltinMatch(catalog, baseUrl, modelId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
