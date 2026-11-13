import type { NextConfig } from "next";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { isVerboseLogging } from "./bin/pi-web-options.js";

const configDir = dirname(fileURLToPath(import.meta.url));

const isDesktopBuild = process.env.PI_WEB_DESKTOP_BUILD === "1";

// mdast-util-gfm-autolink-literal (remark-gfm) ships a RegExp lookbehind that
// Safari parses only from 16.4, which blanked `/` on iOS 16.2 (#753). The loader
// swaps it for an equivalent built at runtime; both bundlers must run it.
const gfmAutolinkEmailLoader = join(configDir, "lib/gfm-autolink-email-loader.cjs");

const nextConfig: NextConfig = {
  logging: {
    // Use Next's source-level switch rather than filtering arbitrary stdout.
    // Query strings can carry credentials, even when diagnostics are enabled.
    incomingRequests: isVerboseLogging() ? { ignore: [/\?/] } : false,
    browserToTerminal: "warn",
    serverFunctions: false,
  },
  // Desktop packaging gets an isolated standalone build. Keeping it outside
  // `.next` prevents a Tauri release build from disrupting `npm run dev`.
  // outputFileTracingRoot roots standalone output in this package. Runtime
  // home paths must still use userHome(): NFT's outside-root check can miss
  // Windows paths on another drive and enumerate the user's profile.
  ...(isDesktopBuild
    ? { output: "standalone" as const, distDir: ".next-desktop" }
    : {}),
  outputFileTracingRoot: configDir,
  // Keep build output and this checkout's tool configuration out of the
  // standalone trace. `lib/branding.ts` imports a JSON file from `src-tauri/`, so
  // the tracer walks that directory, and `tauri build` copies
  // `src-tauri/resources` into `src-tauri/target/<profile>/resources`: without an
  // exclude each packaging run traces the previous run's staged server into the
  // new one and `resources/server` nests inside itself.
  //
  // `.pi/` is not about size: `.pi/mcp.json` can hold the Bearer keys of the
  // developer's MCP endpoints, and the payload is a distributable installer.
  // Nothing under `.pi/` is needed at runtime (a packaged session reads the
  // user's own `~/.pi`).
  //
  // Windows caveat: Next applies each entry as `path.join(dir, exclude)` and
  // picomatch reads the drive backslash as an escape, so on Windows every entry
  // below matches nothing. The list protects POSIX builds only; the defence that
  // holds everywhere is `scripts/prepare-desktop.mjs` (clear build output before
  // tracing, prune the traced `.pi/`, assert with `scripts/packaged-payload.mjs`).
  outputFileTracingExcludes: {
    "/*": [
      ".next/**",
      ".next-desktop/**",
      ".pi/**",
      "src-tauri/target/**",
      "src-tauri/resources/server/**",
      "src-tauri/resources/node/**",
    ],
  },
  experimental: {
    ...(isDesktopBuild
      ? { webpackBuildWorker: true, webpackMemoryOptimizations: true }
      : {}),
    // proxy.ts matches /api/:path*, and Next buffers the request body whenever
    // a proxy is present, capped at 10 MB by default. The upload route accepts
    // up to 100 MB per request, so raise the buffer above that or large uploads
    // are truncated and fail with "Failed to parse body as FormData."
    proxyClientMaxBodySize: "128mb",
    optimizePackageImports: ["react-syntax-highlighter"],
  },
  // next/image is only used for the static logo, so the /_next/image optimizer
  // (and its sharp/libheif attack surface, see GHSA-2xp9-vwfh-vxw4) is not needed.
  images: { unoptimized: true },
  // `next dev` runs Turbopack and `npm run build` runs webpack.
  turbopack: {
    rules: {
      "**/mdast-util-gfm-autolink-literal/lib/index.js": { loaders: [gfmAutolinkEmailLoader] },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /[\\/]mdast-util-gfm-autolink-literal[\\/]lib[\\/]index\.js$/,
      loader: gfmAutolinkEmailLoader,
    });
    return config;
  },
  // Node modules keep the syntax they ship unless listed here, and mermaid's
  // lazy diagram chunks are full of class `static {}` blocks (#753).
  transpilePackages: ["mermaid", "@mermaid-js/parser"],
  serverExternalPackages: [
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // The bundled React preview runtime. The app page fetches it and
        // inlines it into preview documents; revalidate so an app update is
        // picked up at once.
        source: "/preview-runtime/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
