// Pure-TypeScript perceptual hashing (dHash) for image dedup.
//
// Strategy: difference hash on a 9x8 grayscale downscale -> 64 bits -> 16 hex.
// Each row compares 9 horizontally-adjacent pixels => 8 bits; 8 rows => 64 bits.
//
// RUNTIME NOTE: Cloudflare Workers does NOT ship a DOM <canvas>. We rely on the
// runtime providing `createImageBitmap` + `OffscreenCanvas` (the spec's intended
// path). Those are feature-detected at call time and typed as `any` to avoid
// pulling in the DOM lib. If they are unavailable in your deployment, this
// function returns null and the caller transparently falls back to exact
// source_id dedup only (see README "Perceptual dedup" note).

const g: any = globalThis as any;

export async function computeDHash(
  bytes: Uint8Array,
  mime: string,
): Promise<string | null> {
  try {
    if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') {
      return null; // perceptual hashing unsupported here -> exact-id dedup only
    }

    const W = 9;
    const H = 8;

    const blob = new Blob([bytes], { type: mime });
    const bitmap = await g.createImageBitmap(blob);
    const canvas = new g.OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(bitmap, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H); // RGBA, row-major

    // Grayscale (luma) per pixel.
    const gray = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4];
      const gg = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
    }

    // Row-wise difference hash -> 64-bit string.
    let bits = '';
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W - 1; col++) {
        const left = gray[row * W + col];
        const right = gray[row * W + col + 1];
        bits += left > right ? '1' : '0';
      }
    }

    return bitsToHex(bits); // 64 bits -> 16 hex chars
  } catch {
    return null;
  }
}

function bitsToHex(bits: string): string {
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two equal-length hex hashes (0..64). */
export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
