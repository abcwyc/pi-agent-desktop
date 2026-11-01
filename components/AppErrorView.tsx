"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { isDarkTheme, isThemePreference, type ResolvedTheme } from "@/lib/theme";

/**
 * Same resolution as THEME_INIT_SCRIPT. Needed because an error during
 * hydration makes React re-render from the root, which drops the attributes
 * that script set, and global-error replaces the document entirely.
 */
function applyStoredTheme() {
  let preference: string | null = null;
  try {
    preference = localStorage.getItem("pi-theme");
  } catch {}
  const resolved: ResolvedTheme = isThemePreference(preference) && preference !== "auto"
    ? preference
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.classList.toggle("dark", isDarkTheme(resolved));
}

function describeError(error: Error & { digest?: string }): string {
  const lines = [`${error.name || "Error"}: ${error.message || String(error)}`];
  if (error.digest) lines.push(`Digest: ${error.digest}`);
  lines.push(`URL: ${window.location.href}`, `User agent: ${navigator.userAgent}`);
  if (error.stack) lines.push("", error.stack);
  return lines.join("\n");
}

/**
 * Replaces Next's generic "This page couldn't load" screen. The packaged app
 * has no DevTools, so the error and its stack are shown on the page for the
 * user to screenshot or copy into a bug report.
 */
export function AppErrorView({
  error,
  onRetry,
}: {
  error: Error & { digest?: string };
  onRetry?: () => void;
}) {
  const [details, setDetails] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    applyStoredTheme();
    setDetails(describeError(error));
    console.error(error);
  }, [error]);

  const copyDetails = () => {
    void copyText(details).then(() => setCopied(true), () => {});
  };

  return (
    <main className="app-error" role="alert">
      <div className="app-error-card">
        <h1 className="app-error-title">This page hit an error while loading</h1>
        <p className="app-error-hint">
          {error.digest
            ? "The local server failed while rendering. Its log (server.log) has the full stack."
            : "Please copy the details below, or take a screenshot, and include them in your bug report."}
        </p>
        <pre className="app-error-details">{details}</pre>
        <div className="app-error-actions">
          <button type="button" className="native-button" onClick={copyDetails} disabled={!details}>
            {copied ? "Copied" : "Copy details"}
          </button>
          {onRetry && (
            <button type="button" className="native-button" onClick={onRetry}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="native-button native-button-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    </main>
  );
}
