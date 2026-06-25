// Fetch image bytes and validate format / size / dimensions.
//
// Dimensions are parsed straight from the file header (JPEG SOF, PNG IHDR, GIF
// logical screen descriptor) so we do NOT need a canvas just to validate — this
// works on any Workers runtime. (Perceptual hashing in dedup.ts is the only part
// that needs OffscreenCanvas, and it degrades gracefully.)

import { log } from './log';
import type { FetchedImage, PostingConfig } from './types';

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
};

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export async function fetchImage(url: string): Promise<FetchedImage | null> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'news-repost-bot/1.0 (+image-fetch)' },
      redirect: 'follow',
    });
  } catch (e) {
    log.warn('image fetch threw', { url, error: String(e) });
    return null;
  }

  if (!resp.ok) {
    log.warn('image fetch non-200', { url, status: resp.status });
    return null;
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  const { mime, ext } = detectFormat(buf, contentType, url);
  const dims = getImageDimensions(buf);

  return {
    bytes: buf,
    mime,
    ext,
    sizeBytes: buf.byteLength,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  };
}

export function validateImage(img: FetchedImage, cfg: PostingConfig): ValidationResult {
  const allowed = cfg.allowed_formats.map((f) => f.toLowerCase());
  if (!allowed.includes(img.ext)) {
    return { ok: false, reason: `format ${img.ext} not in allowed_formats` };
  }
  if (!MIME_BY_EXT[img.ext]) {
    return { ok: false, reason: `unsupported/undetected image format` };
  }

  const maxBytes = cfg.max_filesize_mb * 1024 * 1024;
  if (img.sizeBytes > maxBytes) {
    return { ok: false, reason: `size ${img.sizeBytes} > max ${maxBytes}` };
  }
  if (img.sizeBytes < 64) {
    return { ok: false, reason: 'image too small / empty' };
  }

  // If dimensions couldn't be parsed we don't hard-fail (some odd encodings),
  // but we do enforce the minimums when we have them.
  if (img.width != null && img.height != null) {
    if (img.width < cfg.min_image_width || img.height < cfg.min_image_height) {
      return {
        ok: false,
        reason: `dimensions ${img.width}x${img.height} below min ${cfg.min_image_width}x${cfg.min_image_height}`,
      };
    }
  }

  return { ok: true };
}

// ---- format + dimension parsing (pure TS) ----

function detectFormat(
  buf: Uint8Array,
  contentType: string,
  url: string,
): { mime: string; ext: string } {
  // Magic bytes win over content-type/extension (most reliable).
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  ) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif' };
  }

  // Fall back to content-type, then URL extension.
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (contentType.includes('png')) return { mime: 'image/png', ext: 'png' };
  if (contentType.includes('gif')) return { mime: 'image/gif', ext: 'gif' };

  const m = url.toLowerCase().match(/\.(jpe?g|png|gif)(?:[?#].*)?$/);
  if (m) {
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    return { mime: MIME_BY_EXT[ext] || 'application/octet-stream', ext };
  }

  return { mime: 'application/octet-stream', ext: 'bin' };
}

export function getImageDimensions(
  buf: Uint8Array,
): { width: number; height: number } | null {
  // PNG: width/height are big-endian uint32 at offsets 16 and 20 (inside IHDR).
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    const width = readU32BE(buf, 16);
    const height = readU32BE(buf, 20);
    if (width && height) return { width, height };
  }

  // GIF: logical screen width/height are little-endian uint16 at offsets 6 and 8.
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf[6] | (buf[7] << 8);
    const height = buf[8] | (buf[9] << 8);
    if (width && height) return { width, height };
  }

  // JPEG: scan segments for a Start-Of-Frame marker, then read height/width.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      // SOF0..SOF15 carry dimensions, excluding DHT(C4)/JPG(C8)/DAC(CC).
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf &&
        marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        const height = (buf[off + 5] << 8) | buf[off + 6];
        const width = (buf[off + 7] << 8) | buf[off + 8];
        if (width && height) return { width, height };
        return null;
      }
      // Skip this segment using its length field.
      const len = (buf[off + 2] << 8) | buf[off + 3];
      if (len < 2) break;
      off += 2 + len;
    }
  }

  return null;
}

function readU32BE(buf: Uint8Array, o: number): number {
  return (buf[o] * 0x1000000) + (buf[o + 1] << 16) + (buf[o + 2] << 8) + buf[o + 3];
}
