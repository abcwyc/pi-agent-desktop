import { NextResponse } from "next/server";
import { existsSync } from "fs";
import {
  addWorktree,
  findCurrentWorktreePath,
  listLocalBranches,
  listRemoteBranches,
  listWorktrees,
  partitionBranchList,
  removeWorktree,
  resolveProject,
  switchBranch,
  worktreeRemovalRequiresForce,
} from "@/lib/worktree";
import { allowFileRoot, isCwdAllowed } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";

/** Same gate as /api/files: only session cwds / project roots / explicitly
 *  allowed dirs may be inspected or mutated through this endpoint. */
async function checkCwdAllowed(cwd: string): Promise<NextResponse | null> {
  return (await isCwdAllowed(cwd)) ? null : NextResponse.json({ error: "Access denied" }, { status: 403 });
}

// GET /api/worktrees?cwd=  →  { projectRoot, projectKey, isGit, isTopLevel, currentWorktreePath, worktrees }
//   &branches=1 additionally returns { branches (local), remoteBranches (remote-only) }
export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd");
    if (!cwd) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(cwd);
    if (denied) return denied;

    const project = await resolveProject(cwd);
    let worktrees: Awaited<ReturnType<typeof listWorktrees>> = [];
    let currentWorktreePath: string | null = null;
    let isGit = true;
    try {
      // For a removed-worktree cwd (session of a deleted worktree), fall back
      // to the inferred project root so the switcher still shows the project.
      worktrees = await listWorktrees(existsSync(cwd) ? cwd : project.projectRoot);
      currentWorktreePath = findCurrentWorktreePath(worktrees, cwd);
    } catch {
      isGit = false;
    }
    // Every listed path is a git-verified worktree of this project; allow the
    // file explorer to browse them even before they have any session (the
    // in-memory allowlist from addWorktree does not survive server restarts).
    for (const w of worktrees) allowFileRoot(w.path);

    const includeBranches = new URL(req.url).searchParams.get("branches") === "1";
    let branches: string[] = [];
    let remoteBranches: string[] = [];
    if (includeBranches && isGit) {
      try {
        const base = existsSync(cwd) ? cwd : project.projectRoot;
        const [local, remote] = await Promise.all([listLocalBranches(base), listRemoteBranches(base)]);
        ({ local: branches, remoteOnly: remoteBranches } = partitionBranchList(local, remote));
      } catch {
        branches = [];
        remoteBranches = [];
      }
    }

    return NextResponse.json({
      projectRoot: project.projectRoot,
      projectKey: projectIdentityKey(project.projectRoot),
      isGit,
      isTopLevel: project.isTopLevel,
      currentWorktreePath,
      worktrees,
      ...(includeBranches ? { branches, remoteBranches } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/worktrees  body: { cwd, branch }  →  { path, branch }
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    const result = await addWorktree(body.cwd, body.branch);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// PUT /api/worktrees  body: { cwd, branch }  →  { branch }
// Checks out the branch in the cwd's own checkout (local branch, or a new
// tracking branch when the name only exists on one remote).
export async function PUT(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; branch?: string };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.branch || typeof body.branch !== "string") {
      return NextResponse.json({ error: "branch is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;
    if (!existsSync(body.cwd)) {
      return NextResponse.json({ error: `Directory does not exist: ${body.cwd}` }, { status: 400 });
    }

    const result = await switchBranch(body.cwd, body.branch);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/worktrees  body: { cwd, path, force? }
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; path?: string; force?: boolean };
    if (!body.cwd || typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    if (!body.path || typeof body.path !== "string") {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    const denied = await checkCwdAllowed(body.cwd);
    if (denied) return denied;

    await removeWorktree(body.cwd, body.path, body.force === true);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Git refuses some worktree removals without --force, including worktrees
    // with submodule state. Surface that so the UI can offer confirmation.
    const dirty = worktreeRemovalRequiresForce(message);
    return NextResponse.json({ error: message, dirty }, { status: dirty ? 409 : 400 });
  }
}
