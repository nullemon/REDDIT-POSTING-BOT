# news-repost-bot

A **multi-source news image repost bot** that runs on **Cloudflare Workers**. On a
cron schedule it pulls images from curated sources — **Twitter/X** verified
news/official accounts, **subreddits**, and **Instagram** (via an external API) —
deduplicates them, and posts them to target subreddits under your authenticated
Reddit account.

It is **transparently automated**: bot disclosure is built in (per Reddit
[bottiquette](https://www.reddit.com/wiki/bottiquette)), it is fully
config-driven, and every source is isolated so one failure can't sink the run.

> **Use responsibly.** Only auto-post to subreddits you own/moderate or that
> explicitly allow bots, keep your account's profile bio marked as a bot, credit
> sources, and respect each platform's Terms of Service and rate limits. The
> defaults (disclosure on, allowlist on, conservative rate caps) are there for a
> reason — keep them on until you've vetted a target.

---

## How it works

```
Cron Trigger (every 30 min)
      │
  scheduled() handler
      │
  Parse CONFIG_JSON  →  per-source "is it due?" check (KV: lastrun:<source>)
      │
  Source adapters ──┬── RedditSource    (native fetch, public listings)
                    ├── TwitterSource   (X API v2, account allowlist + verified gate)
                    └── InstagramSource (isolated external scraper API, fail-soft)
      │
  Normalize → ImageItem
      │
  Target router (all | mapping | round_robin)
      │
  Per planned post:  bot-rules gate → exact dedup (D1) → fetch+validate bytes
                     → perceptual dedup (dHash, D1) → rate gate (KV)
                     → Reddit 4-step image upload+submit → disclosure → record (D1)
```

### Project layout

```
src/
  index.ts            scheduled() entry + orchestration
  config.ts           parse + validate CONFIG_JSON
  types.ts            ImageItem, SourceConfig, PostingConfig, Env, ...
  sources/
    base.ts           SourceAdapter interface
    reddit.ts         subreddit image listings
    twitter.ts        X API v2, account allowlist + require_verified gate
    instagram.ts      ISOLATED external API, fail-soft
  reddit/
    auth.ts           OAuth password grant + KV token cache + refresh
    post.ts           the 4-step image upload+submit + disclosure comment/flair
  dedup.ts            pure-TS dHash + Hamming distance
  images.ts           fetch bytes, detect format, parse dimensions, validate
  router.ts           all | mapping | round_robin
  rate.ts             KV rate limiting, poll scheduling, backoff
  db.ts               D1 queries
  log.ts              structured console logging (wrangler tail)
schema.sql
wrangler.toml
package.json
tsconfig.json
```

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free plan is
  enough to start; cron + D1 + KV are available on free).
- [Node.js](https://nodejs.org/) 18+ and `npm`.
- A Reddit account you control, with a **script** app (below).
- An X/Twitter developer account with a **Bearer token** (for the Twitter source).
- *(Optional)* An external Instagram scraping API (for the Instagram source).

Install dependencies:

```bash
npm install
```

`wrangler` is included as a dev dependency, so the commands below use
`npx wrangler ...`. Log in once:

```bash
npx wrangler login
```

---

## Setup

### 1. Create the D1 database

```bash
npx wrangler d1 create news-repost-bot
```

Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`
(replace `REPLACE_ME`).

Apply the schema (run both so local dev and prod match):

```bash
npm run db:init:local     # local dev DB
npm run db:init:remote    # production DB
# (these wrap: wrangler d1 execute news-repost-bot --local/--remote --file=./schema.sql)
```

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create STATE
```

Copy the printed `id` into `wrangler.toml` under `[[kv_namespaces]]` (replace
`REPLACE_ME`).

### 3. *(Optional)* R2 staging bucket

Only if you want to stage images in R2. Uncomment the `[[r2_buckets]]` block in
`wrangler.toml` and:

```bash
npx wrangler r2 bucket create repost-staging
```

### 4. Reddit script-app setup

1. Go to <https://www.reddit.com/prefs/apps> while logged into the bot account.
2. **Create another app…** → choose **script**.
3. Set the redirect URI to `http://localhost:8080` (unused, but required).
4. Note the **client id** (under the app name) and the **secret**.
5. Make sure the bot account's **profile bio is marked as a bot** (bottiquette).

The bot uses the OAuth *password grant* (resource owner), which is what "script"
apps are for. Your credentials become these secrets:

| Secret | Value |
| --- | --- |
| `REDDIT_CLIENT_ID` | the app's client id |
| `REDDIT_CLIENT_SECRET` | the app's secret |
| `REDDIT_USER` | the bot account's username |
| `REDDIT_PASS` | the bot account's password |
| `REDDIT_USER_AGENT` | a unique UA, e.g. `news-repost-bot/1.0 by u/yourname` |

> Reddit **requires** a descriptive, unique `User-Agent`. A generic UA will get
> you rate-limited or blocked.

### 5. X / Twitter API setup

1. Create a project + app at <https://developer.x.com/>.
2. Generate an **App-only Bearer Token**.
3. That token becomes the `TWITTER_BEARER_TOKEN` secret.

For **news**, use `"mode": "account"` with a curated `accounts[]` allowlist — do
**not** use open hashtag firehoses, which pull in junk. Set
`"require_verified": true` to additionally drop non-verified authors. (See the
note in `src/sources/twitter.ts`: post-2023, `verified` reflects *paid*
verification, so the **allowlist is the strong guarantee** of genuine-ness.)

### 6. External Instagram API plug-in *(optional, do this last)*

There is no native-runnable IG scraper on Workers, so the Instagram source calls
an **external scraping API of your choice** and is **fully isolated** — if it's
unconfigured or breaks, it's skipped and Reddit/Twitter continue unaffected.

1. Pick any Instagram scraping API vendor (this repo does **not** hardcode one).
2. Set two secrets:
   - `IG_API_BASE_URL` — the vendor's endpoint base URL
   - `EXTERNAL_IG_API_KEY` — your API key for that vendor
3. Adapt the request/response mapping to your vendor in
   **`src/sources/instagram.ts`** — see the two clearly-commented
   `VENDOR ADAPTATION POINT` sections (`buildRequestUrl` and
   `mapVendorResponse`). They already tolerate several common field names.

If you don't want Instagram, just leave those two secrets unset and remove the
`instagram` entry from `CONFIG_JSON.sources`.

### 7. Set all secrets

```bash
npx wrangler secret put REDDIT_CLIENT_ID
npx wrangler secret put REDDIT_CLIENT_SECRET
npx wrangler secret put REDDIT_USER
npx wrangler secret put REDDIT_PASS
npx wrangler secret put REDDIT_USER_AGENT
npx wrangler secret put TWITTER_BEARER_TOKEN
# Optional (Instagram):
npx wrangler secret put IG_API_BASE_URL
npx wrangler secret put EXTERNAL_IG_API_KEY
```

For **local development**, put the same keys in a `.dev.vars` file (gitignored):

```
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER=...
REDDIT_PASS=...
REDDIT_USER_AGENT=news-repost-bot/1.0 by u/yourname
TWITTER_BEARER_TOKEN=...
IG_API_BASE_URL=...
EXTERNAL_IG_API_KEY=...
```

### 8. Configure behavior (`CONFIG_JSON`)

All behavior lives in `CONFIG_JSON` in `wrangler.toml` `[vars]`. Edit the
sources, targets, routing, rate limits, and disclosure there. Key fields:

- **`dry_run`** — when `true`, fetch + dedup + log intended posts but **never
  submit** and never write history. Flip to `false` to go live.
- **`sources[]`** — each has a `type` (`reddit`/`twitter`/`instagram`), a
  `poll_interval_min` (honored across cron fires via KV), and `targets[]`.
- **`posting.routing_mode`**:
  - `mapping` — each item → its own source's `targets` (default).
  - `all` — each item → **every** target sub across all sources.
  - `round_robin` — items distributed one-per-target across all targets.
- **`posting.bot_disclosure`** — `mode` = `comment` | `flair` | `none`.
- **`posting.respect_subreddit_bot_rules`** + **`moderated_subs_allowlist`** —
  when the flag is on, only subs in the allowlist are posted to; others are
  skipped with a warning so you can vet them first.
- **`posting.rate_limit`** — `min_seconds_between_posts`,
  `max_posts_per_target_per_hour`, `max_posts_per_run`.

### 9. Deploy

```bash
npm run deploy        # wrangler deploy
```

The cron trigger (`*/30 * * * *`) is registered automatically from
`wrangler.toml`.

### 10. Watch the logs

```bash
npm run tail          # wrangler tail — structured JSON logs, live
```

---

## Dry run (test before going live)

1. Set `"dry_run": true` in `CONFIG_JSON` and `npm run deploy` (or just run
   locally — see below).
2. Trigger and watch: every intended post is logged as `DRY RUN would post`
   with the target, title, image URL, and source id. Nothing is submitted and no
   state is written, so dry runs are repeatable.
3. When the logs look right, set `"dry_run": false`, redeploy, and the next cron
   fire goes live.

### Local development / manual trigger

```bash
npx wrangler dev
# then, in another terminal:
curl "http://localhost:8787/run"            # one run, honoring poll intervals
curl "http://localhost:8787/run?force=1"    # ignore "is it due?" and run every source
```

The `/run` endpoint returns a JSON summary (`posted`, `would_post`, `planned`,
per-reason `skipped` counts). Use it with `dry_run: true` to safely exercise the
whole pipeline.

---

## Deduplication

Two layers, both scoped per-target (so `routing_mode: "all"` can still fan one
item out to several subs):

1. **Exact** — `(source_id, target_sub)` lookup in D1. Cheap; catches re-fetches.
2. **Perceptual** — 64-bit **dHash** compared by Hamming distance
   (`dedup_hamming_threshold`) against the most recent **500** posts to that
   target. Catches the same image arriving via a different URL/source.

> **Perceptual-dedup runtime note.** The dHash needs `createImageBitmap` +
> `OffscreenCanvas`. These are feature-detected at runtime; if your Workers
> deployment doesn't provide them, `computeDHash` returns `null` and the bot
> **gracefully degrades to exact `source_id` dedup only** (logged, never
> crashes). Format/size/dimension validation does **not** depend on canvas — it
> parses image headers directly — so that always works.

---

## The Reddit 4-step image flow

Implemented as raw REST in `src/reddit/post.ts` (no PRAW — it can't run on
Workers). Each step is documented inline:

1. **Token** — `POST /api/v1/access_token` (password grant), cached in KV
   (`token:reddit`), auto-refreshed on 401 (`src/reddit/auth.ts`).
2. **Lease** — `POST /api/media/asset.json` to request an S3 upload lease for the
   image's mime type.
3. **Upload** — multipart `POST` of the image bytes to the S3 URL from the lease
   (all signed fields in order, file last).
4. **Submit** — `POST /api/submit` with `kind=image` and the uploaded asset URL.
   The new post's fullname is resolved (directly or via the submit websocket) so
   the disclosure comment/flair can be attached.

Token-expiry retry (401 → refresh) and 429 exponential backoff are built in.

---

## Bottiquette checklist

Before flipping `dry_run` off, confirm:

- [ ] The bot account's **profile bio is marked as a bot**.
- [ ] `bot_disclosure.enabled` is `true` (comment or flair).
- [ ] `respect_subreddit_bot_rules` is `true` and every target is in
      `moderated_subs_allowlist` — i.e. you **own/mod** it or have **confirmed it
      allows bots**.
- [ ] You've checked each target subreddit's rules/wiki for bot + repost policy.
- [ ] Rate limits are conservative (`max_posts_per_target_per_hour`,
      `min_seconds_between_posts`, `max_posts_per_run`).
- [ ] Sources are **credited** (the default `caption_template` appends
      `via {author}`).
- [ ] For Twitter news: `mode: "account"`, a curated `accounts[]`, and
      `require_verified: true`.
- [ ] You're respecting the source platforms' ToS and any image rights.

---

## Safety / resilience (built in)

- Each source adapter is wrapped in try/catch — one dead source never kills the run.
- Reddit OAuth auto-refreshes on 401; 429s back off exponentially.
- `max_posts_per_run` hard cap; per-target hourly cap via KV; a wall-clock
  ceiling defers leftover posts to the next fire.
- Bounded dedup comparison set (most recent 500 rows) to stay within CPU limits.
- `respect_subreddit_bot_rules` skips non-allowlisted subs with a warning.
- Instagram is fully isolated and fail-soft.
- `dry_run` mode for safe end-to-end testing.
- Everything observable via `wrangler tail`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `reddit token mint failed: HTTP 401` | Wrong client id/secret/user/pass, or 2FA on the account. Use an app password / disable 2FA for the script app. |
| `429` from Reddit | Generic or duplicate `REDDIT_USER_AGENT`; make it unique. Lower rate limits. |
| Twitter returns nothing | Bearer token missing/invalid, handle has no recent **photo** tweets, or `require_verified` dropped them. |
| `instagram skipped: ... not configured` | `IG_API_BASE_URL` / `EXTERNAL_IG_API_KEY` unset — expected if you're not using IG. |
| Posts not deduping by image | OffscreenCanvas unavailable in your runtime → perceptual hash off (exact dedup still works). See the dedup note above. |
| `target not in moderated_subs_allowlist` | Add the sub to `moderated_subs_allowlist` (only after vetting it). |
| Nothing happens on cron | Check `npm run tail`; confirm `database_id`/KV `id` are filled in `wrangler.toml`. |
