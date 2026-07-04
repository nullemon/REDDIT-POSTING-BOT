# news-repost-bot — Devvit (Reddit-native) version

A **Reddit → Reddit** image repost bot built on **Devvit** (Reddit's Developer
Platform). You install it on a subreddit you **moderate**; it pulls fresh image
posts from the **source subreddits** you configure and reposts them into your sub
on a schedule — with dedup, a rate cap, and an optional bot-disclosure comment.

**Why this instead of the Cloudflare version?** It runs on **Reddit's own
servers**, uses Reddit's built-in **Redis** (dedup) and **Scheduler** (cron), and
authenticates automatically — so there's **no D1/KV/Cloudflare setup and no API
keys**. Everything it does is the **native Reddit API**, so there are no external
domains to get approved.

> **Important reality check.** "Runs on Reddit's servers" does **not** mean
> unlimited or ban-proof. Devvit apps are subject to Reddit's Developer Terms and
> content policy. Only install on subs you moderate, keep disclosure on, and don't
> mass-repost copyrighted content — Reddit can remove apps and action accounts
> that abuse this. This is the *sanctioned* path, not a loophole.

### What this version does NOT do

Twitter/X and Instagram are **not** here. Devvit's external fetch is allow-listed
and **reviewed by Reddit admins**, and a cross-platform scraping/repost app is
unlikely to be approved. If you need Twitter/IG sources, use the **Cloudflare
Worker** in the parent folder for those, pointing at the same subreddits.

---

## Which Devvit runtime this targets

Devvit currently has two flavors. This app targets the stable
**`@devvit/public-api`** runtime (verified to type-check against **v0.13.6**). If
`devvit new` scaffolds the newer "Devvit Web" structure for you, you can still
drop `src/main.tsx` in as-is — the Reddit/Redis/Scheduler calls are the same.

---

## Prerequisites

- Node 18+.
- A Reddit account that is a **moderator** of the target subreddit(s).
- The Devvit CLI:
  ```bash
  npm install -g devvit
  devvit login          # opens the browser to authorize your Reddit account
  ```
  (First-time devs may need to verify their account / accept the developer terms.)

---

## Setup

```bash
cd devvit-bot
npm install
```

1. **Name your app.** Edit `devvit.yaml` and set a **globally-unique**, lowercase
   `name` (4+ chars, hyphens allowed), e.g. `yourname-repost-bot`.

2. **Upload it to your account** (stays private to you):
   ```bash
   devvit upload
   ```

3. **Install it on a subreddit you moderate:**
   ```bash
   devvit install r/YourSubreddit
   ```
   or, to develop live against a test sub with hot-reload + logs:
   ```bash
   devvit playtest r/YourTestSubreddit
   ```

4. **Configure it.** In the installed subreddit go to **Mod Tools → Apps →
   news-repost-bot** (or the app settings page) and set:
   - **Source subreddits** — comma/newline separated (e.g. `pics, EarthPorn`)
   - **Sort** (Top/Hot/New) and **Timeframe** (for Top)
   - **Posts to scan per source**, **Max reposts per run** (rate cap)
   - **Repost method** — *Crosspost* (credits the original, safest) or *Link repost*
   - **Disclosure comment** on/off + text

That's it. The scheduler runs every 30 minutes automatically. Use the subreddit
menu item **"News repost bot: run now"** (mods only) to trigger a run immediately.

---

## How it works

```
every 30 min (Devvit Scheduler)  ── or ──  mod clicks "run now"
      │
  runRepost(context)
      │  target = the sub the app is installed on
      │  sources = configured source subreddits
      ▼
  for each source:  reddit.getTopPosts/getHotPosts/getNewPosts   (native, no external fetch)
      │  keep image posts only (.jpg/.png/.gif, i.redd.it, galleries)
      ▼
  dedup via Redis hash  seen:<targetSub>   (skip already-reposted ids, 60-day memory)
      ▼
  repost:  crosspost  OR  submitPost(link)   → into your subreddit
      ▼
  optional: submitComment(disclosure)  → on the new post
```

- **Dedup** — `context.redis` hash keyed by target sub; each source post id is
  remembered so it's never reposted twice.
- **Scheduling** — registered on `AppInstall`/`AppUpgrade` via
  `context.scheduler.runJob({ cron: '*/30 * * * *' })`.
- **Auth** — handled by Devvit; the app acts under its own app identity in your
  sub. No OAuth, no secrets.

---

## Change the schedule

Edit the cron in `src/main.tsx` (`rescheduleTick`), then `devvit upload`. The job
re-registers on the next install/upgrade. Devvit also supports seconds-granularity
crons if you want faster ticks.

---

## Bottiquette checklist

- [ ] You **moderate** every target subreddit the app is installed on.
- [ ] Disclosure comment is **on** (and your account bio notes it's a bot).
- [ ] Rate cap (`Max reposts per run`) is conservative.
- [ ] Prefer **Crosspost** mode — it credits the original and is the least
      spammy. Use Link repost only where crossposts are disabled and you have a
      reason to re-host.
- [ ] Source content is appropriate to re-share (respect creators / rights).

---

## Commands reference

| Command | What it does |
| --- | --- |
| `devvit login` | Authorize the CLI with your Reddit account |
| `devvit upload` | Upload/update your app (private to you) |
| `devvit install r/Sub` | Install the app on a sub you moderate |
| `devvit playtest r/Sub` | Live dev on a test sub (hot reload + logs) |
| `devvit logs r/Sub` | Stream logs from an installed app |
| `npm run typecheck` | Type-check `src/main.tsx` locally |
