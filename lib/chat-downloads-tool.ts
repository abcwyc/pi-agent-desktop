import { realpathSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  chatDownloadsDir,
  checkDownloadName,
  DOWNLOAD_MAX_BYTES,
  saveDownload,
  type ChatFileGrants,
} from "./chat-file-access";

export const CHAT_DOWNLOADS_EXTENSION_NAME = "pi-web-chat-downloads";
export const SAVE_TO_DOWNLOADS_TOOL_NAME = "save_to_downloads";

export interface SavedFileDetails {
  path: string;
  name: string;
  size: number;
}

/**
 * `save_to_downloads`: the one way a chat writes to the user's computer. It takes a bare
 * file name and the content, writes into the Downloads folder without replacing anything,
 * and answers with the saved path, which the transcript shows as a file card.
 */
export function createChatDownloadsExtension(options: {
  grants: ChatFileGrants;
  /** Ask the user before every save (Settings › Chats). Read on each call. */
  confirmBeforeSaving: () => boolean;
  downloadsDir?: () => string;
}): InlineExtension {
  return {
    name: CHAT_DOWNLOADS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: SAVE_TO_DOWNLOADS_TOOL_NAME,
        label: "Save to Downloads",
        description: `Save a file to the user's Downloads folder, for example a document, a script or exported data they asked for. Give a file name only (no folders) and the content. An existing file is never replaced: a taken name gets " (1)" added. Programs and installers are refused. Up to ${DOWNLOAD_MAX_BYTES / (1024 * 1024)} MB.`,
        promptSnippet: "Save a file the user asked for to their Downloads folder",
        parameters: Type.Object({
          filename: Type.String({ description: "File name with extension, for example notes.md. No folder." }),
          content: Type.String({ description: "The file's content: text, or base64 when encoding is base64." }),
          encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
            description: "How content is encoded. Default utf8.",
          })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          const name = checkDownloadName(params.filename);
          if (!name.ok) throw new Error(`Not saved: ${name.reason}.`);
          const data = params.encoding === "base64"
            ? Buffer.from(params.content, "base64")
            : Buffer.from(params.content, "utf8");
          if (options.confirmBeforeSaving()) {
            const allowed = await ctx.ui.confirm(
              "Save a file?",
              `Save "${name.name}" (${data.length} bytes) to your Downloads folder?`,
            );
            if (!allowed) throw new Error("The user declined to save the file.");
          }
          const saved = saveDownload((options.downloadsDir ?? chatDownloadsDir)(), name.name, data);
          // So the chat can read it back, through realpath like every other grant.
          try {
            options.grants.noteSaved(realpathSync(saved.path));
          } catch {
            options.grants.noteSaved(saved.path);
          }
          const details: SavedFileDetails = { path: saved.path, name: saved.name, size: saved.size };
          return {
            content: [{ type: "text", text: `Saved ${saved.name} (${saved.size} bytes) to ${saved.path}` }],
            details,
          };
        },
      }));
    },
  };
}
