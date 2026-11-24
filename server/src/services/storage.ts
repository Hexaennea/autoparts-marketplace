// Where uploaded images live.
//
// * local:    written under settings.uploadDir and served by this app at /media (development, tests).
// * supabase: uploaded to a public Supabase Storage bucket and served from Supabase directly.
//             Uploads use the project's secret (service_role) key, which never leaves the server.
//
// Stored paths (e.g. "products/ab12.webp") are the same in both modes, so the database never
// changes when switching; only the URL prefix does. PARTPILOT_MEDIA_BASE_URL overrides the prefix
// (e.g. a CDN in front of the bucket).

import fs from "node:fs/promises";
import path from "node:path";

export type MediaSettings =
  | { kind: "local" }
  | { kind: "supabase"; url: string; secretKey: string; bucket: string };

export interface StorageSettings {
  uploadDir: string;
  media: MediaSettings;
}

let base = "/media";

/** Set the public URL prefix from settings; call once at startup (app and CLI). */
export function configureStorage(settings: StorageSettings): void {
  base = (process.env.PARTPILOT_MEDIA_BASE_URL ?? defaultBase(settings.media)).replace(/\/+$/, "");
}

function defaultBase(media: MediaSettings): string {
  return media.kind === "supabase" ? `${media.url}/storage/v1/object/public/${media.bucket}` : "/media";
}

/** URL prefix for a stored image path. */
export function mediaBase(): string {
  return base;
}

/** Origin images are served from when it isn't this app (for the CSP img-src), else null. */
export function mediaOrigin(settings: StorageSettings): string | null {
  const prefix = process.env.PARTPILOT_MEDIA_BASE_URL ?? defaultBase(settings.media);
  return /^https?:\/\//.test(prefix) ? new URL(prefix).origin : null;
}

/** Store a WebP image at `rel` (e.g. "products/abc.webp"). */
export async function saveMedia(settings: StorageSettings, rel: string, data: Buffer): Promise<void> {
  if (settings.media.kind === "supabase") {
    await uploadToSupabase(settings.media, rel, data);
    return;
  }
  const file = path.join(settings.uploadDir, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

async function uploadToSupabase(
  media: Extract<MediaSettings, { kind: "supabase" }>,
  rel: string,
  data: Buffer,
): Promise<void> {
  const objectPath = rel.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${media.url}/storage/v1/object/${encodeURIComponent(media.bucket)}/${objectPath}`, {
    method: "POST",
    headers: {
      apikey: media.secretKey,
      authorization: `Bearer ${media.secretKey}`,
      "content-type": "image/webp",
      // Names are random (or fixed demo names), so content at a path never changes.
      "cache-control": "max-age=31536000",
      "x-upsert": "true",
    },
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // Supabase's message is safe to log (it never contains the key); keep it short.
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`Supabase Storage upload failed (${res.status}) for ${rel}: ${detail}`);
  }
}
