// TwitterSource — clean, X API v2 via fetch + bearer token.
//
// News use-case == ACCOUNT MODE with a curated allowlist (cfg.accounts). We do
// NOT use open hashtag firehoses for news because they pull in junk/randoms.
//
// ===================== THE VERIFIED-ACCOUNT GATE =====================
// Two hard gates make "only genuine news Twitter" a rule, not a hope:
//   1. accounts[] allowlist  — in account mode we only ever read tweets from the
//      exact handles you list. Nothing else can enter the pipeline.
//   2. require_verified      — when true we drop any tweet whose author is not
//      verified, checked via the v2 user `verified` field.
//
// IMPORTANT CAVEAT (post-2023 X semantics): the `verified` boolean now reflects
// paid verification (X Premium / Blue / business / government), NOT the old
// "blue check = notable news org" meaning. So the *allowlist* is the strong
// guarantee of genuine-ness; require_verified is a secondary filter. We request
// `verified` and `verified_type` so you can tighten this further if you want
// (e.g. only accept verified_type of 'government'/'business').
// =====================================================================

import { log } from '../log';
import type { ImageItem, TwitterSourceConfig } from '../types';
import type { AdapterCtx, SourceAdapter } from './base';

const API = 'https://api.twitter.com/2';

interface V2Media {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  width?: number;
  height?: number;
}
interface V2User {
  id: string;
  username: string;
  name: string;
  verified?: boolean;
  verified_type?: string;
}
interface V2Tweet {
  id: string;
  text: string;
  author_id?: string;
  attachments?: { media_keys?: string[] };
}
interface V2Response {
  data?: V2Tweet[];
  includes?: { media?: V2Media[]; users?: V2User[] };
  errors?: unknown[];
}

export class TwitterSource implements SourceAdapter {
  readonly key: string;
  constructor(private cfg: TwitterSourceConfig, private ctx: AdapterCtx) {
    this.key = `twitter:${cfg.mode}:${cfg.mode === 'account' ? (cfg.accounts || []).join(',') : cfg.query}`;
  }

  async fetch(): Promise<ImageItem[]> {
    const bearer = this.ctx.env.TWITTER_BEARER_TOKEN;
    if (!bearer) {
      log.warn('twitter skipped: TWITTER_BEARER_TOKEN not set');
      return [];
    }
    return this.cfg.mode === 'hashtag'
      ? this.fetchHashtag(bearer)
      : this.fetchAccounts(bearer);
  }

  // ---- account mode (preferred for news) ----
  private async fetchAccounts(bearer: string): Promise<ImageItem[]> {
    const out: ImageItem[] = [];
    const limit = this.cfg.limit ?? 15;

    for (const handle of this.cfg.accounts || []) {
      try {
        // 1) Resolve handle -> user id, and read verification status.
        const user = await this.lookupUser(handle, bearer);
        if (!user) continue;

        // GATE: require_verified drops non-verified authors outright.
        if (this.cfg.require_verified && user.verified !== true) {
          log.info('twitter handle dropped (not verified)', { handle });
          continue;
        }

        // 2) Pull recent media tweets (photos only), excluding RT/replies.
        const url =
          `${API}/users/${user.id}/tweets?max_results=${Math.min(Math.max(limit, 5), 100)}` +
          `&exclude=retweets,replies` +
          `&expansions=attachments.media_keys` +
          `&media.fields=url,preview_image_url,type,width,height` +
          `&tweet.fields=attachments`;

        const resp = await this.get(url, bearer);
        const body = (await resp.json()) as V2Response;
        if (!resp.ok || body.errors) {
          log.warn('twitter timeline error', { handle, status: resp.status, errors: body.errors });
          continue;
        }

        const mediaByKey = indexMedia(body.includes?.media);
        for (const t of body.data ?? []) {
          for (const item of tweetToItems(t, mediaByKey, user, this.cfg.targets)) {
            out.push(item);
          }
        }
      } catch (e) {
        // One bad handle must not sink the others.
        log.warn('twitter handle failed', { handle, error: String(e) });
      }
    }

    log.info('twitter account source fetched', { handles: (this.cfg.accounts || []).length, found: out.length });
    return out;
  }

  // ---- hashtag mode (optional, non-news) ----
  private async fetchHashtag(bearer: string): Promise<ImageItem[]> {
    const tag = (this.cfg.query || '').replace(/^#/, '');
    if (!tag) return [];
    const limit = Math.min(Math.max(this.cfg.limit ?? 15, 10), 100);

    const url =
      `${API}/tweets/search/recent?query=${encodeURIComponent(`#${tag} has:images -is:retweet`)}` +
      `&max_results=${limit}` +
      `&expansions=attachments.media_keys,author_id` +
      `&media.fields=url,preview_image_url,type,width,height` +
      `&user.fields=verified,verified_type`;

    const resp = await this.get(url, bearer);
    const body = (await resp.json()) as V2Response;
    if (!resp.ok || body.errors) {
      log.warn('twitter search error', { tag, status: resp.status, errors: body.errors });
      return [];
    }

    const mediaByKey = indexMedia(body.includes?.media);
    const usersById = indexUsers(body.includes?.users);
    const out: ImageItem[] = [];

    for (const t of body.data ?? []) {
      const author = t.author_id ? usersById[t.author_id] : undefined;
      // GATE still applies in hashtag mode if require_verified is on.
      if (this.cfg.require_verified && author?.verified !== true) continue;
      const pseudoUser: V2User = author ?? { id: t.author_id || '', username: 'unknown', name: 'unknown' };
      for (const item of tweetToItems(t, mediaByKey, pseudoUser, this.cfg.targets)) {
        out.push(item);
      }
    }

    log.info('twitter hashtag source fetched', { tag, found: out.length });
    return out;
  }

  private async lookupUser(handle: string, bearer: string): Promise<V2User | null> {
    const clean = handle.replace(/^@/, '');
    const url = `${API}/users/by/username/${encodeURIComponent(clean)}?user.fields=verified,verified_type`;
    const resp = await this.get(url, bearer);
    const body = (await resp.json()) as { data?: V2User; errors?: unknown[] };
    if (!resp.ok || !body.data) {
      log.warn('twitter user lookup failed', { handle, status: resp.status, errors: body.errors });
      return null;
    }
    return body.data;
  }

  private get(url: string, bearer: string): Promise<Response> {
    return fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  }
}

function indexMedia(media?: V2Media[]): Record<string, V2Media> {
  const map: Record<string, V2Media> = {};
  for (const m of media ?? []) map[m.media_key] = m;
  return map;
}
function indexUsers(users?: V2User[]): Record<string, V2User> {
  const map: Record<string, V2User> = {};
  for (const u of users ?? []) map[u.id] = u;
  return map;
}

/** Map a tweet's photo media to ImageItem(s) (one per photo). */
function tweetToItems(
  t: V2Tweet,
  mediaByKey: Record<string, V2Media>,
  user: V2User,
  targets: string[],
): ImageItem[] {
  const keys = t.attachments?.media_keys ?? [];
  const items: ImageItem[] = [];
  for (const k of keys) {
    const m = mediaByKey[k];
    if (!m || m.type !== 'photo' || !m.url) continue; // photos only
    items.push({
      url: highestRes(m.url),
      source_id: `twitter:${t.id}:${k}`,
      caption: cleanTweetText(t.text),
      author: `@${user.username}`,
      source_type: 'twitter',
      verified: user.verified === true,
      targets,
    });
  }
  return items;
}

/** Request the original-resolution variant of a pbs.twimg.com photo. */
function highestRes(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('pbs.twimg.com')) {
      u.searchParams.set('name', 'orig');
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Strip the trailing t.co media link Twitter appends to media tweets. */
function cleanTweetText(text: string): string {
  return text.replace(/\s*https:\/\/t\.co\/\w+\s*$/i, '').trim();
}
