import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "@/lib/file-access";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "@/lib/file-types";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { isApiRequestAllowed } from "@/lib/request-security";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  validateUploadFileNames,
} from "@/lib/file-upload";
import {
  parseFormDataWithinLimit,
  parseJsonWithinLimit,
  RequestBodyTooLargeError,
} from "@/lib/bounded-form-data";
import { isDesktopApiRequestAllowed } from "@/lib/desktop-api-auth";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview", "serve", "watch", "watch-dir"] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);
const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;
const MAX_IMPORT_JSON_BYTES = 256 * 1024;
const MAX_IMPORT_FILES = 100;
const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

// MIME types needed when a local HTML document loads its own stylesheets and
// scripts. The regular `read` endpoint returns JSON for text files, while the
// preview iframe needs the actual bytes with a browser-readable content type.
const SERVE_EXT_TO_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  wasm: "application/wasm",
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function getServeMime(filePath: string): string {
  const ext = getFileExt(filePath);
  return getImageMime(filePath)
    || getAudioMime(filePath)
    || getDocumentMime(filePath)
    || SERVE_EXT_TO_MIME[ext]
    || "application/octet-stream";
}

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

async function getUploadDirectory(segments: string[]): Promise<
  { directory: string } | { response: NextResponse }
> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Upload target is not a directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides before writes
  // so a symlink inside an allowed root cannot redirect uploads outside it.
  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale session roots that no longer exist.
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  try {
    const { path: segments } = await params;
    const uploadDirectory = await getUploadDirectory(segments);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    const type = request.nextUrl.searchParams.get("type") ?? "upload";

    if (type === "upload-check") {
      const body = await request.json().catch(() => null) as { fileNames?: unknown } | null;
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(inspectUploadTargets(directory, fileNames));
    }

    if (type === "import") {
      if (!isDesktopApiRequestAllowed(request)) {
        return NextResponse.json({ error: "Desktop authorization required" }, { status: 403 });
      }
      const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
      if (!strategy) {
        return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
      }

      const body = await parseJsonWithinLimit(request, MAX_IMPORT_JSON_BYTES) as { sourcePaths?: unknown } | null;
      if (!Array.isArray(body?.sourcePaths) || !body.sourcePaths.every((item) => typeof item === "string")) {
        return NextResponse.json({ error: "sourcePaths must be an array of strings" }, { status: 400 });
      }
      if (body.sourcePaths.length === 0) {
        return NextResponse.json({ error: "No files selected" }, { status: 400 });
      }
      if (body.sourcePaths.length > MAX_IMPORT_FILES) {
        return NextResponse.json({ error: `Select at most ${MAX_IMPORT_FILES} files` }, { status: 400 });
      }

      const sources: Array<{ sourcePath: string; fileName: string; size: number }> = [];
      for (const rawPath of body.sourcePaths) {
        const trimmed = rawPath.trim();
        if (!trimmed || trimmed.includes("\0")) {
          return NextResponse.json({ error: `Invalid source path: ${rawPath}` }, { status: 400 });
        }
        const useWindows = isWindowsAbsolutePath(trimmed);
        const resolver = useWindows ? path.win32 : path;
        if (!resolver.isAbsolute(trimmed)) {
          return NextResponse.json({ error: `Source path must be absolute: ${rawPath}` }, { status: 400 });
        }
        const sourcePath = resolver.resolve(trimmed);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(sourcePath);
        } catch {
          return NextResponse.json({ error: `File not found: ${path.basename(sourcePath)}` }, { status: 404 });
        }
        if (!stat.isFile() || stat.isSymbolicLink()) {
          return NextResponse.json({ error: `Not a regular file: ${path.basename(sourcePath)}` }, { status: 400 });
        }
        if (stat.size > MAX_UPLOAD_FILE_BYTES) {
          return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
        }
        sources.push({ sourcePath, fileName: path.basename(sourcePath), size: stat.size });
      }

      if (sources.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
        return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
      }

      const fileNames = sources.map((file) => file.fileName);
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }

      const inspection = inspectUploadTargets(directory, fileNames);
      if (strategy === "error" && inspection.conflicts.length > 0) {
        return NextResponse.json({
          error: "One or more files already exist",
          conflicts: inspection.conflicts,
          nonReplaceable: inspection.nonReplaceable,
        }, { status: 409 });
      }

      const conflictSet = new Set(inspection.conflicts);
      const nonReplaceableSet = new Set(inspection.nonReplaceable);
      const uploaded: string[] = [];
      const skipped: string[] = [];
      const errors: Array<{ name: string; error: string }> = [];

      for (const source of sources) {
        const destination = path.join(directory, source.fileName);
        if (conflictSet.has(source.fileName) && strategy === "skip") {
          skipped.push(source.fileName);
          continue;
        }
        if (conflictSet.has(source.fileName) && nonReplaceableSet.has(source.fileName)) {
          errors.push({ name: source.fileName, error: "Cannot replace a directory or symbolic link" });
          continue;
        }
        if (conflictSet.has(source.fileName)) {
          try {
            fs.unlinkSync(destination);
          } catch (error) {
            errors.push({ name: source.fileName, error: error instanceof Error ? error.message : String(error) });
            continue;
          }
        }
        try {
          fs.copyFileSync(source.sourcePath, destination);
          uploaded.push(source.fileName);
        } catch (error) {
          errors.push({ name: source.fileName, error: error instanceof Error ? error.message : String(error) });
        }
      }

      return NextResponse.json(
        { uploaded, skipped, errors },
        { status: errors.length > 0 ? 207 : 200 },
      );
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }

    let formData: FormData;
    try {
      formData = await parseFormDataWithinLimit(request, MAX_UPLOAD_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
      }
      throw error;
    }
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    if (files.some((file) => file.size > MAX_UPLOAD_FILE_BYTES)) {
      return NextResponse.json({ error: "Each upload must be 25MB or smaller" }, { status: 413 });
    }
    if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_TOTAL_BYTES) {
      return NextResponse.json({ error: "Uploads must total 100MB or less" }, { status: 413 });
    }
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const inspection = inspectUploadTargets(directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      const destination = path.join(directory, file.name);
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (conflictSet.has(file.name)) {
        try {
          fs.unlinkSync(destination);
        } catch (error) {
          errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }

      try {
        fs.writeFileSync(destination, bytes, { flag: "wx" });
        uploaded.push(file.name);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Import request is too large" }, { status: 413 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function createFileBodyStream(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const fileStream = fs.createReadStream(filePath, range);
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(filePath: string, asDownload = false): string {
  const disposition = asDownload ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function streamFile(filePath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null, asDownload = false): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(filePath, asDownload),
  };

  if (!rangeHeader) {
    return new Response(createFileBodyStream(filePath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(filePath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const requestedType = request.nextUrl.searchParams.get("type");
    const rawType = requestedType ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return NextResponse.json({ error: "Invalid file request type" }, { status: 400 });
    }
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots();
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
    const allowedBySessionReference =
      !allowedByRoot &&
      type !== "list" &&
      await isFilePathReferencedBySession(filePath, sessionId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!allowedBySessionReference && !isExistingFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (type === "read") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      if (imageMime) {
        if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
          return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
        }
        return streamFile(filePath, stat, imageMime, request.headers.get("range"));
      }
      const audioMime = getAudioMime(filePath);
      if (audioMime) {
        return streamFile(filePath, stat, audioMime, request.headers.get("range"));
      }
      const documentMime = getDocumentMime(filePath);
      if (documentMime) {
        return streamFile(filePath, stat, documentMime, request.headers.get("range"));
      }
      const isHtmlFile = getFileExt(filePath) === "html" || getFileExt(filePath) === "htm";
      const textPreviewMaxBytes = isHtmlFile ? HTML_PREVIEW_MAX_BYTES : TEXT_PREVIEW_MAX_BYTES;
      if (stat.size > textPreviewMaxBytes) {
        return NextResponse.json({
          error: isHtmlFile
            ? "File too large for preview (>10MB)"
            : "File too large for preview (>256KB)",
        }, { status: 413 });
      }
      const content = fs.readFileSync(filePath, "utf-8");
      const language = getLanguage(filePath);
      return NextResponse.json({ content, language, size: stat.size });
    }

    if (type === "download") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime = getImageMime(filePath) || getAudioMime(filePath) || getDocumentMime(filePath) || "application/octet-stream";
      return streamFile(filePath, stat, mime, request.headers.get("range"), true);
    }

    if (type === "serve") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      return streamFile(filePath, stat, getServeMime(filePath), request.headers.get("range"));
    }

    if (type === "meta") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      return NextResponse.json({
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getFileExt(filePath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
      }
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
      }

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { path: filePath },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      let watcher: fs.FSWatcher | null = null;
      let lastMtimeMs = stat.mtimeMs;
      let lastSize = stat.size;
      const stream = new ReadableStream({
        start(controller) {
          const send = (eventName: string, data: Record<string, unknown>) => {
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            try {
              controller.enqueue(new TextEncoder().encode(payload));
            } catch {
              // client disconnected
            }
          };
          // Send initial ping so client knows connection is live
          send("connected", { filePath });
          try {
            watcher = fs.watch(filePath, () => {
              try {
                const s = fs.statSync(filePath);
                // Some platforms emit watch events for file reads/attribute
                // access. Ignore those or the client's refresh read loops.
                if (s.mtimeMs === lastMtimeMs && s.size === lastSize) return;
                lastMtimeMs = s.mtimeMs;
                lastSize = s.size;
                send("change", { mtime: s.mtime.toISOString(), size: s.size });
              } catch {
                send("change", { mtime: new Date().toISOString(), size: 0 });
              }
            });
            watcher.on("error", () => {
              try { controller.close(); } catch { /* ignore */ }
            });
          } catch {
            send("error", { message: "Failed to watch file" });
            controller.close();
          }
        },
        cancel() {
          try { watcher?.close(); } catch { /* ignore */ }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (type === "watch-dir") {
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: "Not a directory" }, { status: 400 });
      }
      let watcher: fs.FSWatcher | null = null;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const isIgnoredEventPath = (eventPath: string | Buffer | null | undefined): boolean => {
        if (typeof eventPath !== "string" || eventPath.length === 0) return false;
        return eventPath
          .split(/[\\/]/)
          .some((segment) =>
            IGNORED_NAMES.has(segment) || IGNORED_SUFFIXES.some((s) => segment.endsWith(s)));
      };
      const stream = new ReadableStream({
        start(controller) {
          const send = (eventName: string, data: Record<string, unknown>) => {
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            try {
              controller.enqueue(new TextEncoder().encode(payload));
            } catch {
              // client disconnected
            }
          };
          send("connected", { path: filePath });
          // Coalesce bursts (builds, git operations) into a single change event.
          const scheduleChange = () => {
            if (debounceTimer) return;
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              send("change", { timestamp: new Date().toISOString() });
            }, 400);
          };
          const handleEvent = (_event: string, filename: string | Buffer | null) => {
            if (isIgnoredEventPath(filename)) return;
            scheduleChange();
          };
          try {
            // Non-recursive on purpose: on Linux, recursive fs.watch walks the
            // whole tree synchronously and stalls the event loop for seconds on
            // large directories (breaks unrelated requests, e.g. the desktop
            // health probe). The list endpoint renders a single level and file
            // content changes are covered by the per-file `watch` above, so
            // top-level entry events are enough; navigation re-lists as needed.
            watcher = fs.watch(filePath, handleEvent);
          } catch {
            // Recursive watching may be unavailable on some platforms; fall
            // back to watching only the top-level directory.
            try {
              watcher = fs.watch(filePath, handleEvent);
            } catch {
              send("error", { message: "Failed to watch directory" });
              controller.close();
              return;
            }
          }
          watcher.on("error", () => {
            try { controller.close(); } catch { /* ignore */ }
          });
        },
        cancel() {
          if (debounceTimer) clearTimeout(debounceTimer);
          try { watcher?.close(); } catch { /* ignore */ }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // A browser resolves relative resources from an HTML document to sibling
    // paths without preserving the document's query string. Treat an
    // untyped file request as an inline file response so relative CSS, JS,
    // images, and other assets loaded by the HTML preview keep working.
    if (type === "list" && requestedType === null && stat.isFile()) {
      return streamFile(filePath, stat, getServeMime(filePath), request.headers.get("range"));
    }

    // type === "list"
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    // Avoid per-entry stat calls for normal files and directories. Symlinks and
    // filesystems without directory type information use the stat fallback.
    const dirents = fs.readdirSync(filePath, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(filePath, d.name));
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: 0, modified: "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: filePath });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
