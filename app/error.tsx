"use client";

import { AppErrorView } from "@/components/AppErrorView";

/** Errors thrown while rendering a page; the root layout (theme, fonts) still applies. */
export default function PageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AppErrorView error={error} onRetry={reset} />;
}
