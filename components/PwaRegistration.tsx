"use client";

import { useEffect } from "react";
import { isTauriDesktop } from "@/lib/desktop-updater";

export function PwaRegistration() {
  useEffect(() => {
    // The desktop shell has no offline requirement, and a registered worker
    // persists in the webview's origin-scoped cache across installs and can
    // serve stale bundles. Skip registration and drop any previous worker.
    if (isTauriDesktop()) {
      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker
          .getRegistrations()
          .then((registrations) =>
            registrations.forEach((registration) => void registration.unregister())
          )
          .catch(() => {});
      }
      return;
    }
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) {
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the Pi Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
