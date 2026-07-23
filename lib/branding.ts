/**
 * Local product branding.
 *
 * Keep this separate from the upstream package/repository names so syncing a
 * newer agegr/pi-web release cannot silently change the user-facing brand.
 */
export const PRODUCT_NAME = "Pi Agent" as const;

import desktopPackage from "../src-tauri/pi-agent-desktop-package.json";

/** Name and version of this packaged desktop distribution. */
export const APP_DISTRIBUTION_NAME = "pi-agent-desktop" as const;
export const APP_VERSION = desktopPackage.version;
export const APP_VERSION_DISPLAY = APP_VERSION.endsWith(".0")
  ? APP_VERSION.slice(0, -2)
  : APP_VERSION;
