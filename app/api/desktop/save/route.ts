import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "@/lib/file-access";
import {
  readRequestBytesWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { isDesktopApiRequestAllowed } from "@/lib/desktop-api-auth";
import { MAX_DESKTOP_SAVE_BYTES } from "@/lib/desktop-api";

export const runtime = "nodejs";

function resolveAbsolutePath(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const useWindows = isWindowsAbsolutePath(trimmed);
  const resolver = useWindows ? path.win32 : path;
  if (!resolver.isAbsolute(trimmed)) return null;
  return resolver.resolve(trimmed);
}

function assertWritableDest(destPath: string): string | null {
  try {
    if (fs.existsSync(destPath)) {
      const stat = fs.lstatSync(destPath);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        return "Destination must be a regular file path";
      }
    } else {
      const parent = path.dirname(destPath);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        return "Destination directory does not exist";
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!isDesktopApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
  }

  try {
    const encodedDest = request.headers.get("x-pi-dest-path");
    if (!encodedDest) {
      return NextResponse.json({ error: "X-Pi-Dest-Path header is required" }, { status: 400 });
    }
    let destPath: string | null;
    try {
      destPath = resolveAbsolutePath(decodeURIComponent(encodedDest));
    } catch {
      return NextResponse.json({ error: "Invalid destination path" }, { status: 400 });
    }
    if (!destPath) {
      return NextResponse.json({ error: "Destination must be an absolute path" }, { status: 400 });
    }

    const destError = assertWritableDest(destPath);
    if (destError) return NextResponse.json({ error: destError }, { status: 400 });

    const bytes = await readRequestBytesWithinLimit(request, MAX_DESKTOP_SAVE_BYTES);
    fs.writeFileSync(destPath, bytes);
    return NextResponse.json({ ok: true, destPath });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "File is too large to save" }, { status: 413 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
