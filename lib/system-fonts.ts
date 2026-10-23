import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeInstalledFonts, type InstalledFont } from "./installed-fonts.ts";

const execFileAsync = promisify(execFile);
const options = { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" as const };

// WPF enumerates the Windows font collection, including localized family names.
// The script is constant: no request values or font names become executable code.
const WINDOWS_FONTS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName PresentationCore
$families = @([System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object {
  [pscustomobject]@{ family = $_.Source; names = @($_.FamilyNames.GetEnumerator() | ForEach-Object {
    [pscustomobject]@{ lang = $_.Key.IetfLanguageTag; name = $_.Value }
  }) }
})
ConvertTo-Json -InputObject $families -Depth 5 -Compress
`;

async function enumerateSystemFonts(): Promise<InstalledFont[]> {
  let raw: unknown;
  if (process.platform === "win32") {
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_FONTS_SCRIPT], options);
    raw = JSON.parse(stdout.replace(/^\uFEFF/, ""));
  } else if (process.platform === "darwin") {
    const { stdout } = await execFileAsync("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"], options);
    const data = JSON.parse(stdout) as { SPFontsDataType?: { typefaces?: { family?: string }[] }[] };
    raw = (data.SPFontsDataType ?? []).flatMap((file) => (file.typefaces ?? []).map((face) => ({ family: face.family })));
  } else if (process.platform === "linux") {
    const { stdout } = await execFileAsync("fc-list", ["--format=%{family}\n"], options);
    raw = stdout.split(/\r?\n/).flatMap((line) => line.split(",").map((family) => ({ family: family.trim() })));
  } else {
    throw new Error("System font enumeration is unavailable on this platform");
  }
  const fonts = normalizeInstalledFonts(raw);
  if (!fonts.length) throw new Error("No installed fonts found");
  return fonts;
}

let cached: { fonts: InstalledFont[]; expires: number } | undefined;
let pending: Promise<InstalledFont[]> | undefined;

export function listSystemFonts(): Promise<InstalledFont[]> {
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.fonts);
  if (!pending) pending = enumerateSystemFonts().then((fonts) => {
    cached = { fonts, expires: Date.now() + 60000 };
    return fonts;
  }).finally(() => { pending = undefined; });
  return pending;
}
