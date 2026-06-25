// InstagramSource — ISOLATED, fail-soft, external scraper API.
//
// ============== INSTAGRAM FRAGILITY / INTEGRATION POINT ==============
// There is NO native-runnable Instagram scraper on Cloudflare Workers, and IG
// actively fights scraping, so this adapter is intentionally the weakest link
// and is fully quarantined:
//
//   * It calls an EXTERNAL Instagram scraping API that YOU choose. We do NOT
//     hardcode a vendor. Configure it via two secrets:
//         IG_API_BASE_URL     — the scraper endpoint base URL
//         EXTERNAL_IG_API_KEY — your API key for that service
//
//   * If either secret is missing, or the call fails, or the response shape is
//     unexpected, this adapter logs and returns [] — it NEVER throws and NEVER
//     blocks Reddit/Twitter. IG is the last source wired in and the first to be
//     skipped when broken.
//
//   * Every scraper vendor returns a different JSON shape. The request builder
//     and `mapVendorResponse()` below are the ONE place you adapt to whatever
//     service you plug in. They are written defensively to accept several common
//     field names; tweak them to match your vendor's docs.
// ====================================================================

import { log } from '../log';
import type { Env, ImageItem, InstagramSourceConfig } from '../types';
import type { AdapterCtx, SourceAdapter } from './base';

export class InstagramSource implements SourceAdapter {
  readonly key: string;
  constructor(private cfg: InstagramSourceConfig, private ctx: AdapterCtx) {
    this.key = `instagram:${cfg.mode}:${cfg.query}`;
  }

  async fetch(): Promise<ImageItem[]> {
    const env = this.ctx.env;

    // --- configuration gate: skip silently-but-loudly if not set up ---
    if (!env.IG_API_BASE_URL || !env.EXTERNAL_IG_API_KEY) {
      log.warn('instagram skipped: IG_API_BASE_URL / EXTERNAL_IG_API_KEY not configured');
      return [];
    }

    try {
      const url = buildRequestUrl(env, this.cfg);

      // Most vendors accept the key as a header; some want it as a query param.
      // Adjust to match your provider (header is the common case).
      const resp = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${env.EXTERNAL_IG_API_KEY}`,
          'x-api-key': env.EXTERNAL_IG_API_KEY, // harmless if the vendor ignores it
          'Accept': 'application/json',
        },
      });

      if (!resp.ok) {
        log.warn('instagram api non-200 (skipping)', { status: resp.status });
        return [];
      }

      const json = await resp.json();
      const items = mapVendorResponse(json, this.cfg);
      log.info('instagram source fetched', { query: this.cfg.query, found: items.length });
      return items;
    } catch (e) {
      // Hard guarantee: IG failure is swallowed here.
      log.warn('instagram fetch failed (skipping, non-fatal)', { error: String(e) });
      return [];
    }
  }
}

// --- VENDOR ADAPTATION POINT #1: build the request URL --------------------
// Tweak query params to match your scraper's API. We pass mode + query + limit.
function buildRequestUrl(env: Env, cfg: InstagramSourceConfig): string {
  const base = env.IG_API_BASE_URL!.replace(/\/+$/, '');
  const params = new URLSearchParams({
    type: cfg.mode, // 'account' | 'hashtag'
    query: cfg.query, // handle or hashtag
    limit: String(cfg.limit ?? 10),
  });
  return `${base}?${params.toString()}`;
}

// --- VENDOR ADAPTATION POINT #2: map the response to ImageItem[] ----------
// Written to tolerate several common shapes. Edit field names to match yours.
function mapVendorResponse(json: any, cfg: InstagramSourceConfig): ImageItem[] {
  // Find the array of posts wherever the vendor put it.
  const posts: any[] =
    (Array.isArray(json) && json) ||
    json?.data ||
    json?.items ||
    json?.posts ||
    json?.results ||
    [];

  const out: ImageItem[] = [];
  for (const p of posts) {
    const imageUrl: string | undefined =
      p.image_url || p.display_url || p.imageUrl || p.media_url || p.thumbnail_src;
    if (!imageUrl) continue; // skip videos / shapes we can't use

    const shortcode: string =
      p.shortcode || p.code || p.id || p.pk || cryptoishKey(imageUrl);
    const username: string =
      p.username || p.owner?.username || p.user?.username || cfg.query;
    const caption: string =
      p.caption || p.edge_media_to_caption?.edges?.[0]?.node?.text || '';

    out.push({
      url: imageUrl,
      source_id: `instagram:${shortcode}`,
      caption: typeof caption === 'string' ? caption : '',
      author: `@${username} (IG)`,
      source_type: 'instagram',
      verified: false,
      targets: cfg.targets,
    });
  }
  return out;
}

// Deterministic fallback id when a vendor omits a stable shortcode.
function cryptoishKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `u${(h >>> 0).toString(16)}`;
}
