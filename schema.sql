-- D1 schema for the news repost bot.
-- Apply with:
--   wrangler d1 execute news-repost-bot --local  --file=./schema.sql   (local dev)
--   wrangler d1 execute news-repost-bot --remote --file=./schema.sql   (production)

CREATE TABLE IF NOT EXISTS posted (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT,        -- 'reddit' | 'twitter' | 'instagram'
  source_id TEXT,          -- permalink / tweet id / shortcode (exact-match dedup key)
  dhash TEXT,              -- 64-bit perceptual hash, hex (nullable if hashing unavailable)
  image_url TEXT,          -- original source image URL
  target_sub TEXT,         -- subreddit we posted to
  reddit_post_id TEXT,     -- t3_xxxxx fullname of the created submission
  posted_at INTEGER        -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_source_id ON posted(source_id);
CREATE INDEX IF NOT EXISTS idx_dhash ON posted(dhash);
CREATE INDEX IF NOT EXISTS idx_posted_at ON posted(posted_at);
-- Composite index supports the per-(source_id, target) re-fetch dedup check.
CREATE INDEX IF NOT EXISTS idx_source_target ON posted(source_id, target_sub);
