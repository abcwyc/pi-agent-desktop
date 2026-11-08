import type { TabOpen } from "./tab-session";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** `sessionId` is this tab's memory (`withTabOpen`), not the URL's `?session=`. */
  sessionFromTab?: boolean;
  sidebarCollapsed: boolean;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : (searchParams.get("session") || null),
    sidebarCollapsed: searchParams.get("sidebar") === "collapsed",
  };
}

/**
 * Apply per-tab memory to a navigation snapshot that was taken from the URL
 * alone. Returns the same object when the URL already chose a cwd or session,
 * or when this tab has nothing stored.
 *
 * A remembered session fills `sessionId` and sets `sessionFromTab`. A
 * remembered new-session composer fills `requestedCwd` so reload shows that
 * UI instead of the previous chat.
 *
 * Call this after mount. Reading sessionStorage during the first client render
 * (including a `useState` initializer) makes SSR HTML diverge from the client
 * tree — sessionStorage is empty on the server — and React reports a
 * hydration text mismatch in the sidebar / placeholder.
 */
export function withTabOpen(
  navigation: InitialNavigation,
  tabOpen: TabOpen | null,
): InitialNavigation {
  if (navigation.requestedCwd || navigation.sessionId || !tabOpen) {
    return navigation;
  }
  if (tabOpen.kind === "session") {
    return { ...navigation, sessionId: tabOpen.sessionId, sessionFromTab: true };
  }
  return { ...navigation, requestedCwd: tabOpen.cwd };
}

/**
 * The session the URL's `?session=` asked for, or null (none, or one this tab
 * remembered). When that session is gone, nothing takes its place: the
 * project the sidebar then adopts does not restore its last open session, as
 * a project switch does, nor put that session in the URL (#1168). A gone
 * session that only this tab remembered falls back as a fresh tab does.
 */
export function linkedSessionId(navigation: InitialNavigation): string | null {
  return navigation.sessionFromTab ? null : navigation.sessionId;
}
