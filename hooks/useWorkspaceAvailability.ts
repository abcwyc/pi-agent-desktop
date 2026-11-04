"use client";

// Fork-owned: probes whether the session's workspace folder still exists, so the
// composer can say so instead of reporting a model error. AppShell (upstream-owned)
// only calls this.

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { UnavailableWorkspaceNotice, WorkspaceAvailability, WorkspaceRecheckState } from "@/lib/workspace-availability";

export function useWorkspaceAvailability(
  cwd: string | null,
  setModelsRefreshKey: Dispatch<SetStateAction<number>>,
) {
  // "unknown": the probe itself failed, so nothing is blocked on its account.
  const [workspaceStatus, setWorkspaceStatus] = useState<{ cwd: string; availability: WorkspaceAvailability | "unknown" } | null>(null);
  const workspaceStatusRef = useRef(workspaceStatus);
  const [workspaceStatusCheck, setWorkspaceStatusCheck] = useState(0);
  // A recheck that finds the same answer changes nothing on screen, so the button
  // looked dead. Track it so the banner can say "checking" and "still unavailable".
  const [recheck, setRecheck] = useState<{ cwd: string; state: WorkspaceRecheckState } | null>(null);

  // A workspace deleted outside the app keeps its history, but every cwd-scoped
  // request then fails and the composer reported it as a model error (#1061).
  // Probe the folder itself so the chat can say what happened and hold new runs.
  useEffect(() => {
    if (!cwd) return;
    const probedCwd = cwd;
    const controller = new AbortController();
    fetch(`/api/cwd/status?cwd=${encodeURIComponent(probedCwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as { availability?: WorkspaceAvailability };
        return response.ok && data.availability ? data.availability : "unknown" as const;
      })
      .catch((error) => (error instanceof DOMException && error.name === "AbortError" ? null : "unknown" as const))
      .then((availability) => {
        if (!availability || controller.signal.aborted) return;
        const previous = workspaceStatusRef.current;
        const recovered = availability === "available"
          && previous?.cwd === probedCwd
          && previous.availability !== "available"
          && previous.availability !== "unknown";
        workspaceStatusRef.current = { cwd: probedCwd, availability };
        setWorkspaceStatus({ cwd: probedCwd, availability });
        setRecheck((current) => (
          current?.cwd === probedCwd && current.state === "checking"
            ? (availability === "available" || availability === "unknown" ? null : { cwd: probedCwd, state: "unchanged" })
            : current
        ));
        // The model list loaded while the folder was gone only holds its error.
        if (recovered) setModelsRefreshKey((key) => key + 1);
      });
    return () => controller.abort();
  }, [cwd, workspaceStatusCheck, setModelsRefreshKey]);

  const workspaceAvailability = cwd && workspaceStatus?.cwd === cwd
    ? workspaceStatus.availability
    : null;
  const recheckState = cwd && recheck?.cwd === cwd ? recheck.state : undefined;
  const unavailableWorkspace = useMemo<UnavailableWorkspaceNotice | null>(() => (
    cwd && workspaceAvailability && workspaceAvailability !== "available" && workspaceAvailability !== "unknown"
      ? { cwd, availability: workspaceAvailability, recheck: recheckState }
      : null
  ), [cwd, workspaceAvailability, recheckState]);
  const recheckWorkspace = useCallback(() => {
    if (!cwd) return;
    setRecheck({ cwd, state: "checking" });
    setWorkspaceStatusCheck((check) => check + 1);
  }, [cwd]);

  return { workspaceAvailability, unavailableWorkspace, recheckWorkspace };
}
