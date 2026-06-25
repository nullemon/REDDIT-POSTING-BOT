// Shared types for the news repost bot.

/**
 * Cloudflare bindings + secrets + vars available on `env`.
 * Bindings (DB/STATE/IMAGES) come from wrangler.toml.
 * Secrets are set via `wrangler secret put <NAME>`.
 * CONFIG_JSON is a plain var (also in wrangler.toml).
 */
export interface Env {
  // Bindings
  DB: D1Database;
  STATE: KVNamespace;
  IMAGES?: R2Bucket; // optional R2 staging bucket

  // Plain var
  CONFIG_JSON: string;

  // Reddit secrets (script app, password grant)
  REDDIT_CLIENT_ID: string;
  REDDIT_CLIENT_SECRET: string;
  REDDIT_USER: string;
  REDDIT_PASS: string;
  REDDIT_USER_AGENT: string;

  // Twitter / X secret
  TWITTER_BEARER_TOKEN?: string;

  // Instagram external scraper API (isolated, optional). Vendor-agnostic.
  IG_API_BASE_URL?: string;
  EXTERNAL_IG_API_KEY?: string;
}

/** A normalized image candidate produced by every source adapter. */
export interface ImageItem {
  url: string;            // direct image URL to download
  source_id: string;      // stable unique id used for exact-match dedup
  caption: string;        // text/title to use when building the post title
  author: string;         // attribution (subreddit author, @handle, ig username)
  source_type: SourceType;
  verified: boolean;      // author verification status (twitter); false elsewhere
  targets: string[];      // target subreddits configured for the owning source
}

export type SourceType = 'reddit' | 'twitter' | 'instagram';
export type RoutingMode = 'all' | 'mapping' | 'round_robin';
export type DisclosureMode = 'comment' | 'flair' | 'none';

// ---- Source configs (discriminated by `type`) ----

export interface RedditSourceConfig {
  type: 'reddit';
  name: string;                     // subreddit name (no r/ prefix)
  sort?: 'hot' | 'new' | 'top' | 'rising';
  time_filter?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  limit?: number;
  poll_interval_min?: number;
  targets: string[];
}

export interface TwitterSourceConfig {
  type: 'twitter';
  mode: 'account' | 'hashtag';
  accounts?: string[];              // required when mode === 'account'
  query?: string;                   // hashtag/term when mode === 'hashtag'
  sort?: 'recent' | 'top';
  require_verified?: boolean;
  limit?: number;
  poll_interval_min?: number;
  targets: string[];
}

export interface InstagramSourceConfig {
  type: 'instagram';
  mode: 'account' | 'hashtag';
  query: string;                    // handle or hashtag
  limit?: number;
  poll_interval_min?: number;
  targets: string[];
}

export type SourceConfig =
  | RedditSourceConfig
  | TwitterSourceConfig
  | InstagramSourceConfig;

// ---- Posting config ----

export interface BotDisclosureConfig {
  enabled: boolean;
  mode: DisclosureMode;
  text?: string;
  flair_text?: string;
  flair_template_id?: string;
}

export interface RateLimitConfig {
  min_seconds_between_posts: number;
  max_posts_per_target_per_hour: number;
  max_posts_per_run: number;
}

export interface PostingConfig {
  routing_mode: RoutingMode;
  min_image_width: number;
  min_image_height: number;
  max_filesize_mb: number;
  allowed_formats: string[];
  caption_template: string;
  dedup_hamming_threshold: number;
  bot_disclosure: BotDisclosureConfig;
  respect_subreddit_bot_rules: boolean;
  moderated_subs_allowlist: string[];
  rate_limit: RateLimitConfig;
}

export interface BotConfig {
  dry_run: boolean;
  sources: SourceConfig[];
  posting: PostingConfig;
}

/** A single planned post: one image item routed to one target subreddit. */
export interface RoutedPost {
  item: ImageItem;
  target: string;
}

/** Raw image bytes + detected metadata returned by the fetch/validate layer. */
export interface FetchedImage {
  bytes: Uint8Array;
  mime: string;       // image/jpeg | image/png | image/gif
  ext: string;        // jpg | png | gif
  sizeBytes: number;
  width: number | null;
  height: number | null;
}
