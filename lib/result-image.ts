const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/**
 * A file name for a tool-result image. Takes the block's media type, not its src: history
 * serves large tool-result images from an API URL, which carries no type of its own.
 */
export function resultImageFileName(mediaType: string | undefined, index: number): string {
  return `image-${index + 1}.${(mediaType && IMAGE_EXTENSIONS[mediaType.toLowerCase()]) ?? "png"}`;
}
