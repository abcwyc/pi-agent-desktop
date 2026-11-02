"use client";

import { AppErrorView } from "@/components/AppErrorView";
import "./globals.css";
import "./native-theme.css";

/**
 * Errors thrown by the root layout itself. This replaces the layout, so it
 * brings its own <html>/<body> and stylesheets.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppErrorView error={error} />
      </body>
    </html>
  );
}
