import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { defaultCwdPath } from "@/lib/default-cwd";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Creates ~/pi-cwd/<YYYYMMDD> (local date) if it doesn't exist and returns the path.
// The client then selects it through /api/cwd/validate like any other directory.
// The base comes from userHome() (inside defaultCwdPath) rather than homedir()
// directly — see the note there for why a literal home directory breaks the
// Windows build.
export async function POST() {
  try {
    const dir = defaultCwdPath();
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
