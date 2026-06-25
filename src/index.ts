// Entry point + orchestration for the news repost bot.
//
//   Cron fires -> scheduled() -> run()
//     parse config
//     for each DUE source: adapter.fetch()  (each wrapped in try/catch)
//     route items -> (item, target) plan
//     for each plan: bot-rules gate -> dedup -> fetch+validate -> dhash dedup
//                    -> rate gate -> submit -> disclose -> record
//
// A `fetch()` handler is included so you can trigger a run manually during local
// development: `curl localhost:8787/run` (add ?force=1 to ignore poll intervals).

import { alreadyPosted, hasSimilarDhash, recordPost } from './db';
import { computeDHash } from './dedup';
import { parseConfig } from './config';
import { fetchImage, validateImage } from './images';
import { log } from './log';
import {
  isSourceDue,
  markSourceRun,
  releasePostSlot,
  reservePostSlot,
  sleep,
} from './rate';
import { applyFlair, postDisclosureComment, submitImagePost } from './reddit/post';
import { routeItems } from './router';
import { InstagramSource } from './sources/instagram';
import { RedditSource } from './sources/reddit';
import { TwitterSource } from './sources/twitter';
import type { SourceAdapter } from './sources/base';
import type { BotConfig, Env, ImageItem, SourceConfig } from './types';

// Wall-clock safety ceiling for one invocation. The inter-post delay loop checks
// this so a big batch + min_seconds_between_posts can't overrun the cron budget;
// leftover items are simply picked up on the next fire.
const MAX_RUN_MS = 240_000;

interface RunSummary {
  dry_run: boolean;
  sources_polled: number;
  items_fetched: number;
  planned: number;
  posted: number;
  would_post: number;
  skipped: Record<string, number>;
}

export default {
  async scheduled(_event, env, ctx): Promise<void> {
    // Keep the worker alive until the run finishes.
    ctx.waitUntil(
      run(env, { force: false }).catch((e) =>
        log.error('scheduled run threw', { error: String(e) }),
      ),
    );
  },

  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/run') {
      const force = url.searchParams.get('force') === '1';
      try {
        const summary = await run(env, { force });
        return Response.json(summary);
      } catch (e) {
        return new Response(`run failed: ${String(e)}\n`, { status: 500 });
      }
    }
    return new Response('news-repost-bot ok — POST/GET /run to trigger\n');
  },
} satisfies ExportedHandler<Env>;

async function run(env: Env, opts: { force: boolean }): Promise<RunSummary> {
  const runStart = Date.now();
  const cfg = parseConfig(env); // throws on bad config -> aborts run

  log.info('run start', {
    dry_run: cfg.dry_run,
    sources: cfg.sources.length,
    routing: cfg.posting.routing_mode,
    force: opts.force,
  });

  // ---- 1. Fetch from each DUE source (failures are isolated) --------------
  const items: ImageItem[] = [];
  let sourcesPolled = 0;

  for (const source of cfg.sources) {
    const adapter = makeAdapter(source, env);
    const due = opts.force || (await isSourceDue(env.STATE, adapter.key, source.poll_interval_min ?? 0, runStart));
    if (!due) {
      log.info('source not due, skipping', { key: adapter.key });
      continue;
    }
    try {
      const fetched = await adapter.fetch();
      items.push(...fetched);
      sourcesPolled++;
      // Only advance poll state on a real run so dry runs stay repeatable.
      if (!cfg.dry_run) await markSourceRun(env.STATE, adapter.key, runStart);
    } catch (e) {
      // One dead source never kills the run.
      log.error('source failed (continuing)', { key: adapter.key, error: String(e) });
    }
  }

  // ---- 2. Route items to target subs --------------------------------------
  const planned = routeItems(items, cfg.posting);
  log.info('routing complete', { items: items.length, planned: planned.length });

  // ---- 3. Post loop -------------------------------------------------------
  const rl = cfg.posting.rate_limit;
  const allowlist = new Set(cfg.posting.moderated_subs_allowlist);
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let posted = 0;
  let wouldPost = 0;
  const acted = () => posted + wouldPost; // counts toward max_posts_per_run

  for (const plan of planned) {
    if (acted() >= rl.max_posts_per_run) {
      log.info('max_posts_per_run reached', { cap: rl.max_posts_per_run });
      break;
    }
    if (Date.now() - runStart > MAX_RUN_MS) {
      log.warn('wall-clock budget reached, deferring rest to next fire');
      break;
    }

    const { item, target } = plan;

    // (a) Subreddit-bot-rules gate.
    if (cfg.posting.respect_subreddit_bot_rules && !allowlist.has(target)) {
      log.warn('target not in moderated_subs_allowlist, skipping', { target });
      skip('not_allowlisted');
      continue;
    }

    // (b) Exact dedup by (source_id, target).
    if (await alreadyPosted(env.DB, item.source_id, target)) {
      skip('dup_source_id');
      continue;
    }

    // (c) Download + validate the image bytes.
    const img = await fetchImage(item.url);
    if (!img) {
      skip('fetch_failed');
      continue;
    }
    const valid = validateImage(img, cfg.posting);
    if (!valid.ok) {
      log.info('image rejected', { reason: valid.reason, url: item.url });
      skip('invalid_image');
      continue;
    }

    // (d) Perceptual dedup (falls back to exact-only if hashing unavailable).
    const dhash = await computeDHash(img.bytes, img.mime);
    if (dhash && (await hasSimilarDhash(env.DB, dhash, target, cfg.posting.dedup_hamming_threshold))) {
      skip('dup_dhash');
      continue;
    }

    const title = buildTitle(cfg.posting.caption_template, item);

    // (e) Dry run: log the intended post and move on — no submit, no state writes.
    if (cfg.dry_run) {
      log.info('DRY RUN would post', { target, title, image_url: item.url, source_id: item.source_id });
      wouldPost++;
      continue;
    }

    // (f) Reserve an hourly rate slot for this target.
    if (!(await reservePostSlot(env.STATE, target, rl.max_posts_per_target_per_hour, runStart))) {
      skip('rate_capped');
      continue;
    }

    // (g) The real 4-step image upload + submit.
    const result = await submitImagePost(env, target, title, img);
    if (!result.ok) {
      log.error('post failed', { target, error: result.error });
      await releasePostSlot(env.STATE, target, runStart); // give the slot back
      skip('post_failed');
      continue;
    }

    // (h) Bot disclosure (comment or flair), best-effort.
    await maybeDisclose(env, cfg, target, result.postFullname);

    // (i) Record to D1 so future fires dedup against it.
    await recordPost(env.DB, {
      source_type: item.source_type,
      source_id: item.source_id,
      dhash,
      image_url: item.url,
      target_sub: target,
      reddit_post_id: result.postFullname ?? '',
      posted_at: Date.now(),
    });

    posted++;
    log.info('posted', { target, post: result.postFullname ?? result.postUrl ?? '?', n: posted });

    // (j) Space out posts, but never blow the wall-clock budget.
    if (acted() < rl.max_posts_per_run && rl.min_seconds_between_posts > 0) {
      const waitMs = rl.min_seconds_between_posts * 1000;
      if (Date.now() - runStart + waitMs <= MAX_RUN_MS) {
        await sleep(waitMs);
      } else {
        log.warn('skipping inter-post delay to respect wall-clock budget');
      }
    }
  }

  const summary: RunSummary = {
    dry_run: cfg.dry_run,
    sources_polled: sourcesPolled,
    items_fetched: items.length,
    planned: planned.length,
    posted,
    would_post: wouldPost,
    skipped,
  };
  log.info('run complete', summary as unknown as Record<string, unknown>);
  return summary;
}

function makeAdapter(source: SourceConfig, env: Env): SourceAdapter {
  const ctx = { env };
  switch (source.type) {
    case 'reddit':
      return new RedditSource(source, ctx);
    case 'twitter':
      return new TwitterSource(source, ctx);
    case 'instagram':
      return new InstagramSource(source, ctx);
  }
}

async function maybeDisclose(
  env: Env,
  cfg: BotConfig,
  target: string,
  postFullname?: string,
): Promise<void> {
  const bd = cfg.posting.bot_disclosure;
  if (!bd.enabled || bd.mode === 'none') return;
  if (!postFullname) {
    log.warn('cannot apply disclosure: post fullname unresolved', { target });
    return;
  }
  if (bd.mode === 'comment') {
    const text = bd.text || '🤖 This was posted automatically by a bot.';
    const ok = await postDisclosureComment(env, postFullname, text);
    log.info('disclosure comment', { target, ok });
  } else if (bd.mode === 'flair') {
    const ok = await applyFlair(env, target, postFullname, bd.flair_text, bd.flair_template_id);
    log.info('disclosure flair', { target, ok });
  }
}

/**
 * Build the post title from caption_template. Reddit titles are single-line, so
 * we collapse all whitespace (the template's blank lines become spaces) and cap
 * at 300 chars. Empty captions fall back to the author or a generic label.
 */
function buildTitle(template: string, item: ImageItem): string {
  let t = template
    .replace(/\{caption\}/g, item.caption || '')
    .replace(/\{author\}/g, item.author || '');
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) t = (item.caption || item.author || 'Image').replace(/\s+/g, ' ').trim();
  return t.slice(0, 300);
}
