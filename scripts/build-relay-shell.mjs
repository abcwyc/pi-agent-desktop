// Build the phone shell for the relay's entry host (docs/remote-relay.md):
//   node scripts/build-relay-shell.mjs [--out <dir>]
// Output is a static site to serve at an origin root (any static host; the
// relay can also serve it with RELAY_SHELL_DIR, trusting the relay with code).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outArg = process.argv.indexOf("--out");
const out = resolve(outArg > 0 ? process.argv[outArg + 1] : join(root, "relay-shell", "dist"));
const shell = join(out, "__shell");

rmSync(out, { recursive: true, force: true });
mkdirSync(shell, { recursive: true });

await build({
  entryPoints: [join(root, "relay-shell", "shell.ts")],
  outfile: join(shell, "shell.js"),
  bundle: true,
  format: "esm",
  // X25519 in WebCrypto: Safari 17, Chrome 133.
  target: ["safari17", "chrome120"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  logLevel: "warning",
});

cpSync(join(root, "relay-shell", "index.html"), join(shell, "index.html"));
cpSync(join(root, "relay-shell", "sw.js"), join(out, "tunnel-sw.js"));
cpSync(join(root, "public", "icons", "icon-192.png"), join(shell, "icon-192.png"));
cpSync(join(root, "public", "icons", "icon-512.png"), join(shell, "icon-512.png"));
writeFileSync(join(shell, "manifest.webmanifest"), JSON.stringify({
  id: "/__shell/",
  name: "Pi",
  short_name: "Pi",
  description: "Your Pi, from your phone, end-to-end encrypted",
  start_url: "/__shell/",
  scope: "/",
  display: "standalone",
  background_color: "#1a1a1a",
  theme_color: "#1a1a1a",
  icons: [
    { src: "/__shell/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/__shell/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
}, null, 2));
// First visit to the bare origin, before the service worker exists.
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Pi</title><meta http-equiv="refresh" content="0; url=/__shell/"><script>location.replace("/__shell/" + location.hash)</script>\n`);
console.log(`relay shell built in ${out}`);
