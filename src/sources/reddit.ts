// RedditSource — clean, native fetch against Reddit's public JSON listings.
//
// Pulls image submissions from a subreddit listing and normalizes them. This is
// the adapter that powers "copy a post from another subreddit and re-upload it
// to mine": we capture the original image URL + the original post title (used as
// the new post's caption) + the permalink as the dedup source_id.

import { log } from '../log';
import { getRedditToken } from '../reddit/auth';
import type { ImageItem, RedditSourceConfig } from '../types';
import type { AdapterCtx, SourceAdapter } from './base';

interface RedditListing {
  data?: { children?: RedditChild[] };
}

interface RedditChild {
  data: {
    id: string;
    title: string;
    author: string;
    permalink: string;
    url?: string;
    url_overridden_by_dest?: string;
    post_hint?: string;
    is_gallery?: boolean;
    is_video?: boolean;
    over_18?: boolean;
    media_metadata?: Record<string, { s?: { u?: string; gif?: string } }>;
    gallery_data?: { items: { media_id: string }[] };
    preview?: { images?: { source?: { url?: string } }[] };
  };
}

export class RedditSource implements SourceAdapter {
  readonly key: string;
  constructor(private cfg: RedditSourceConfig, private ctx: AdapterCtx) {
    this.key = `reddit:${cfg.name}:${cfg.sort}`;
  }

  async fetch(): Promise<ImageItem[]> {
    const { name, sort = 'hot', time_filter = 'day', limit = 25 } = this.cfg;

    const json = await this.fetchListing(name, sort, time_filter, limit);
    const children = json.data?.children ?? [];
    const items: ImageItem[] = [];

    for (const child of children) {
      const d = child.data;
      if (d.is_video) continue;

      const imageUrl = extractImageUrl(d);
      if (!imageUrl) continue;

      items.push({
        url: imageUrl,
        source_id: `reddit:${d.permalink || d.id}`,
        caption: d.title || '',
        author: d.author ? `u/${d.author}` : 'unknown',
        source_type: 'reddit',
        verified: false,
        targets: this.cfg.targets,
      });
    }

    log.info('reddit source fetched', { sub: name, found: items.length, scanned: children.length });
    return items;
  }

  /**
   * Fetch a subreddit listing. Reddit frequently blocks unauthenticated reads
   * from datacenter IPs (the Workers runtime), so we read via the authenticated
   * OAuth host first (reusing the posting token) and fall back to the public
   * JSON host. The `t=` time filter only matters for sort=top; harmless else.
   */
  private async fetchListing(
    name: string,
    sort: string,
    time_filter: string,
    limit: number,
  ): Promise<RedditListing> {
    const ua = this.ctx.env.REDDIT_USER_AGENT || 'news-repost-bot/1.0';
    const qs = `?limit=${limit}&t=${encodeURIComponent(time_filter)}&raw_json=1`;
    const path = `/r/${encodeURIComponent(name)}/${encodeURIComponent(sort)}`;

    // Attempt 1: authenticated OAuth host (reliable from Workers IPs).
    try {
      const token = await getRedditToken(this.ctx.env);
      const resp = await fetch(`https://oauth.reddit.com${path}${qs}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': ua },
      });
      if (resp.ok) return (await resp.json()) as RedditListing;
      log.warn('reddit oauth listing failed, trying public', { sub: name, status: resp.status });
    } catch (e) {
      log.warn('reddit oauth listing threw, trying public', { sub: name, error: String(e) });
    }

    // Attempt 2: public JSON host.
    const pub = await fetch(`https://www.reddit.com${path}.json${qs}`, {
      headers: { 'User-Agent': ua },
    });
    if (!pub.ok) throw new Error(`reddit listing ${name} -> HTTP ${pub.status}`);
    return (await pub.json()) as RedditListing;
  }
}

/** Pull a single direct image URL out of a submission, if it is an image post. */
function extractImageUrl(d: RedditChild['data']): string | null {
  const candidate = d.url_overridden_by_dest || d.url || '';

  // 1. Direct image hosts / file extensions.
  if (/\.(jpe?g|png|gif)(?:[?#].*)?$/i.test(candidate)) return candidate;
  if (/^https?:\/\/i\.redd\.it\//i.test(candidate)) return candidate;
  // Imgur direct (avoid album/gallery pages which aren't direct images).
  if (/^https?:\/\/i\.imgur\.com\/.+\.(jpe?g|png|gif)/i.test(candidate)) return candidate;

  // 2. Reddit native gallery -> take the first image from media_metadata.
  if (d.is_gallery && d.media_metadata && d.gallery_data) {
    const first = d.gallery_data.items[0]?.media_id;
    const meta = first ? d.media_metadata[first] : undefined;
    const u = meta?.s?.u || meta?.s?.gif;
    if (u) return decodeRedditUrl(u);
  }

  // 3. Last resort: the preview source image (post_hint === 'image').
  if (d.post_hint === 'image' && d.preview?.images?.[0]?.source?.url) {
    return decodeRedditUrl(d.preview.images[0].source.url);
  }

  return null;
}

// Reddit HTML-encodes preview/gallery URLs (&amp;). raw_json=1 mostly fixes this
// but we decode defensively.
function decodeRedditUrl(u: string): string {
  return u.replace(/&amp;/g, '&');
}
