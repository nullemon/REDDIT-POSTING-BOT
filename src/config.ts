// Parse + validate CONFIG_JSON into a typed BotConfig with sane defaults.
// Throwing here aborts the whole run early with a clear message — better than
// posting with a half-broken config.

import type {
  BotConfig,
  Env,
  PostingConfig,
  SourceConfig,
} from './types';

const DEFAULT_POSTING: PostingConfig = {
  routing_mode: 'mapping',
  min_image_width: 600,
  min_image_height: 600,
  max_filesize_mb: 18,
  allowed_formats: ['jpg', 'jpeg', 'png', 'gif'],
  caption_template: '{caption}',
  dedup_hamming_threshold: 5,
  bot_disclosure: { enabled: false, mode: 'none' },
  respect_subreddit_bot_rules: true,
  moderated_subs_allowlist: [],
  rate_limit: {
    min_seconds_between_posts: 90,
    max_posts_per_target_per_hour: 6,
    max_posts_per_run: 20,
  },
};

export function parseConfig(env: Env): BotConfig {
  if (!env.CONFIG_JSON || !env.CONFIG_JSON.trim()) {
    throw new Error('CONFIG_JSON is empty — set it in wrangler.toml [vars].');
  }

  let raw: any;
  try {
    raw = JSON.parse(env.CONFIG_JSON);
  } catch (e) {
    throw new Error(`CONFIG_JSON is not valid JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) {
    throw new Error('CONFIG_JSON.sources must be a non-empty array.');
  }

  const sources: SourceConfig[] = raw.sources.map((s: any, i: number) =>
    validateSource(s, i),
  );

  const posting = mergePosting(raw.posting ?? {});

  return {
    dry_run: Boolean(raw.dry_run),
    sources,
    posting,
  };
}

function validateSource(s: any, idx: number): SourceConfig {
  if (!s || typeof s !== 'object') {
    throw new Error(`sources[${idx}] is not an object.`);
  }
  if (!Array.isArray(s.targets) || s.targets.length === 0) {
    throw new Error(`sources[${idx}] (type=${s.type}) needs a non-empty targets[].`);
  }

  switch (s.type) {
    case 'reddit':
      if (!s.name) throw new Error(`reddit source[${idx}] needs "name" (subreddit).`);
      return {
        type: 'reddit',
        name: String(s.name),
        sort: s.sort ?? 'hot',
        time_filter: s.time_filter ?? 'day',
        limit: clampInt(s.limit, 1, 100, 25),
        poll_interval_min: clampInt(s.poll_interval_min, 0, 100000, 60),
        targets: s.targets.map(String),
      };

    case 'twitter':
      if (s.mode === 'account' && (!Array.isArray(s.accounts) || s.accounts.length === 0)) {
        throw new Error(`twitter source[${idx}] in account mode needs accounts[].`);
      }
      if (s.mode === 'hashtag' && !s.query) {
        throw new Error(`twitter source[${idx}] in hashtag mode needs "query".`);
      }
      return {
        type: 'twitter',
        mode: s.mode === 'hashtag' ? 'hashtag' : 'account',
        accounts: Array.isArray(s.accounts) ? s.accounts.map(String) : [],
        query: s.query ? String(s.query) : undefined,
        sort: s.sort === 'top' ? 'top' : 'recent',
        require_verified: Boolean(s.require_verified),
        limit: clampInt(s.limit, 1, 100, 15),
        poll_interval_min: clampInt(s.poll_interval_min, 0, 100000, 60),
        targets: s.targets.map(String),
      };

    case 'instagram':
      if (!s.query) throw new Error(`instagram source[${idx}] needs "query".`);
      return {
        type: 'instagram',
        mode: s.mode === 'hashtag' ? 'hashtag' : 'account',
        query: String(s.query),
        limit: clampInt(s.limit, 1, 100, 10),
        poll_interval_min: clampInt(s.poll_interval_min, 0, 100000, 180),
        targets: s.targets.map(String),
      };

    default:
      throw new Error(`sources[${idx}] has unknown type "${s.type}".`);
  }
}

function mergePosting(p: any): PostingConfig {
  const rl = p.rate_limit ?? {};
  const bd = p.bot_disclosure ?? {};
  return {
    routing_mode: ['all', 'mapping', 'round_robin'].includes(p.routing_mode)
      ? p.routing_mode
      : DEFAULT_POSTING.routing_mode,
    min_image_width: numOr(p.min_image_width, DEFAULT_POSTING.min_image_width),
    min_image_height: numOr(p.min_image_height, DEFAULT_POSTING.min_image_height),
    max_filesize_mb: numOr(p.max_filesize_mb, DEFAULT_POSTING.max_filesize_mb),
    allowed_formats: Array.isArray(p.allowed_formats)
      ? p.allowed_formats.map((f: any) => String(f).toLowerCase())
      : DEFAULT_POSTING.allowed_formats,
    caption_template: typeof p.caption_template === 'string'
      ? p.caption_template
      : DEFAULT_POSTING.caption_template,
    dedup_hamming_threshold: numOr(p.dedup_hamming_threshold, DEFAULT_POSTING.dedup_hamming_threshold),
    bot_disclosure: {
      enabled: Boolean(bd.enabled),
      mode: ['comment', 'flair', 'none'].includes(bd.mode) ? bd.mode : 'none',
      text: bd.text,
      flair_text: bd.flair_text,
      flair_template_id: bd.flair_template_id,
    },
    // Default ON: only an explicit `false` disables the allowlist gate.
    respect_subreddit_bot_rules: p.respect_subreddit_bot_rules !== false,
    moderated_subs_allowlist: Array.isArray(p.moderated_subs_allowlist)
      ? p.moderated_subs_allowlist.map(String)
      : DEFAULT_POSTING.moderated_subs_allowlist,
    rate_limit: {
      min_seconds_between_posts: numOr(rl.min_seconds_between_posts, DEFAULT_POSTING.rate_limit.min_seconds_between_posts),
      max_posts_per_target_per_hour: numOr(rl.max_posts_per_target_per_hour, DEFAULT_POSTING.rate_limit.max_posts_per_target_per_hour),
      max_posts_per_run: numOr(rl.max_posts_per_run, DEFAULT_POSTING.rate_limit.max_posts_per_run),
    },
  };
}

function numOr(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
