// Image ingestion. Every upload is decoded, size-checked, re-encoded to WebP and stored under a
// random name, so no user-supplied bytes, filenames or metadata (EXIF/GPS) are ever served back.

import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { ApiError } from "../http.js";
import { saveMedia } from "./storage.js";

export const MAX_IMAGE_PIXELS = 16_000_000; // decompression-bomb guard (~4000 x 4000)
export const MAX_SIDE = 1600;
export const THUMB_SIDE = 480;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

export interface StoredImage {
  path: string;
  thumbPath: string;
  width: number;
  height: number;
}

// At most two images are decoded at once, so concurrent uploads can't exhaust memory.
const DECODE_SLOTS = 2;
let busySlots = 0;
const waiters: Array<() => void> = [];

async function acquire(timeoutMs: number): Promise<boolean> {
  if (busySlots < DECODE_SLOTS) {
    busySlots++;
    return true;
  }
  return new Promise<boolean>((resolve) => {
    const grant = () => {
      clearTimeout(timer);
      busySlots++;
      resolve(true);
    };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(grant);
      if (i >= 0) waiters.splice(i, 1);
      resolve(false);
    }, timeoutMs);
    waiters.push(grant);
  });
}

function release(): void {
  busySlots--;
  const next = waiters.shift();
  if (next) next();
}

export async function storeImage(data: Buffer, uploadDir: string, folder = "products"): Promise<StoredImage> {
  if (!(await acquire(10_000))) {
    throw new ApiError(503, "busy", "We're processing other photos. Try again in a moment.");
  }
  try {
    return await store(data, uploadDir, folder);
  } finally {
    release();
  }
}

const unreadable = () => new ApiError(415, "unsupported_type", "That file isn't a readable photo.");

async function store(data: Buffer, uploadDir: string, folder: string): Promise<StoredImage> {
  // Probe the header only (no pixel decode yet).
  let meta: sharp.Metadata;
  try {
    meta = await sharp(data).metadata();
  } catch {
    throw unreadable();
  }
  const srcWidth = meta.width ?? 0;
  const srcHeight = meta.height ?? 0;
  if (!srcWidth || !srcHeight || srcWidth * srcHeight > MAX_IMAGE_PIXELS) throw unreadable();
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw new ApiError(415, "unsupported_type", "Upload a JPEG, PNG or WebP photo.");
  }
  if (srcWidth < 300 || srcHeight < 300) {
    throw new ApiError(422, "image_too_small", "Photos must be at least 300 × 300 pixels.");
  }

  // Full decode: apply EXIF orientation, normalise to sRGB (RGBA when the source has alpha, else RGB),
  // shrink to fit MAX_SIDE. The result is raw pixels, so nothing from the original file survives.
  let pixels: Buffer;
  let info: sharp.OutputInfo;
  try {
    let pipeline = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, pages: 1 })
      .rotate()
      .toColourspace("srgb");
    pipeline = meta.hasAlpha ? pipeline.ensureAlpha() : pipeline.removeAlpha();
    const out = await pipeline
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    pixels = out.data;
    info = out.info;
  } catch {
    throw unreadable();
  }
  const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };

  const name = randomBytes(16).toString("hex");
  const fullRel = `${folder}/${name}.webp`;
  const thumbRel = `${folder}/${name}_t.webp`;
  const full = await sharp(pixels, raw).webp({ quality: 86, effort: 4 }).toBuffer();
  const thumb = await sharp(pixels, raw)
    .resize({ width: THUMB_SIDE, height: THUMB_SIDE, fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
  await Promise.all([saveMedia(uploadDir, fullRel, full), saveMedia(uploadDir, thumbRel, thumb)]);
  return { path: fullRel, thumbPath: thumbRel, width: info.width, height: info.height };
}
