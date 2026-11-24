// Where uploaded images live. They are written to the upload dir and served from /media.
// PARTPILOT_MEDIA_BASE_URL can point image URLs at another public host later
// (e.g. a Google Cloud Storage bucket behind Cloud CDN).

import fs from "node:fs/promises";
import path from "node:path";

let base: string | undefined;

/** URL prefix for a stored image path: "/media" unless PARTPILOT_MEDIA_BASE_URL is set. */
export function mediaBase(): string {
  base ??= (process.env.PARTPILOT_MEDIA_BASE_URL ?? "/media").replace(/\/+$/, "");
  return base;
}

/** Writes a WebP image at `rel` (e.g. "products/abc.webp"). */
export async function saveMedia(uploadDir: string, rel: string, data: Buffer): Promise<void> {
  const file = path.join(uploadDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
