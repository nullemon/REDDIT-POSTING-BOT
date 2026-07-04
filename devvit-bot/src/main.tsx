// News repost bot — Devvit (Reddit Developer Platform) app.
//
// Model: install this app on a subreddit you MODERATE. Each install is
// configured (by that sub's mod) with a list of SOURCE subreddits to pull image
// posts from. On a schedule it copies fresh image posts from the sources into
// the sub it's installed on — via crosspost (credits the original) or a link
// repost. Dedup + scheduling use Devvit's built-in Redis + Scheduler, so there
// is NO external infrastructure to set up and nothing that needs external-fetch
// review: everything here is native Reddit API.

import {
  Devvit,
  SettingScope,
  type JobContext,
  type TriggerContext,
} from '@devvit/public-api';

Devvit.configure({ redditAPI: true, redis: true });

const JOB_NAME = 'repost-tick';
const DEDUP_TTL_SECONDS = 60 * 60 * 24 * 60; // remember posted ids for 60 days

// ---- Per-install configuration (set by the installing moderator) -----------
Devvit.addSettings([
  {
    type: 'paragraph',
    name: 'sourceSubs',
    label: 'Source subreddits to pull image posts from (comma or newline separated, no "r/")',
    scope: SettingScope.Installation,
  },
  {
    type: 'select',
    name: 'sort',
    label: 'Which posts to pull',
    options: [
      { label: 'Top', value: 'top' },
      { label: 'Hot', value: 'hot' },
      { label: 'New', value: 'new' },
    ],
    defaultValue: ['top'],
    scope: SettingScope.Installation,
  },
  {
    type: 'select',
    name: 'timeframe',
    label: 'Timeframe (only used for "Top")',
    options: [
      { label: 'Hour', value: 'hour' },
      { label: 'Day', value: 'day' },
      { label: 'Week', value: 'week' },
    ],
    defaultValue: ['day'],
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'limitPerSource',
    label: 'How many posts to scan per source per run',
    defaultValue: 25,
    scope: SettingScope.Installation,
  },
  {
    type: 'number',
    name: 'maxPerRun',
    label: 'Max reposts per run (rate cap)',
    defaultValue: 3,
    scope: SettingScope.Installation,
  },
  {
    type: 'select',
    name: 'repostMode',
    label: 'Repost method',
    options: [
      { label: 'Crosspost (credits original — safest)', value: 'crosspost' },
      { label: 'Link repost (same title, fresh link post)', value: 'link' },
    ],
    defaultValue: ['crosspost'],
    scope: SettingScope.Installation,
  },
  {
    type: 'boolean',
    name: 'discloseBot',
    label: 'Add a bot-disclosure comment on each repost',
    defaultValue: true,
    scope: SettingScope.Installation,
  },
  {
    type: 'string',
    name: 'disclosureText',
    label: 'Disclosure comment text',
    defaultValue: '🤖 Reposted automatically by a bot. Original is credited.',
    scope: SettingScope.Installation,
  },
]);

// ---- Scheduling: register the recurring job on install/upgrade -------------
Devvit.addTrigger({
  events: ['AppInstall', 'AppUpgrade'],
  onEvent: async (_event, context) => {
    await rescheduleTick(context);
  },
});

async function rescheduleTick(context: TriggerContext): Promise<void> {
  // Cancel any existing jobs so upgrades don't stack duplicates.
  const existing = await context.scheduler.listJobs();
  for (const job of existing) {
    await context.scheduler.cancelJob(job.id);
  }
  await context.scheduler.runJob({ name: JOB_NAME, cron: '*/30 * * * *' });
  console.log('scheduled repost-tick (every 30 min)');
}

Devvit.addSchedulerJob({
  name: JOB_NAME,
  onRun: async (_event, context) => {
    await runRepost(context);
  },
});

// ---- Manual trigger for mods: Subreddit ... menu -> "run now" --------------
Devvit.addMenuItem({
  location: 'subreddit',
  forUserType: 'moderator',
  label: 'News repost bot: run now',
  onPress: async (_event, context) => {
    await runRepost(context);
    context.ui.showToast('Repost tick executed — check logs (devvit logs).');
  },
});

// ---- Core logic ------------------------------------------------------------
async function runRepost(context: JobContext): Promise<void> {
  const targetSub = context.subredditName ?? (await context.reddit.getCurrentSubreddit()).name;

  const settings = await context.settings.getAll();
  const sourceSubs = parseSubs(settings.sourceSubs as string | undefined);
  if (sourceSubs.length === 0) {
    console.log('no source subreddits configured; nothing to do');
    return;
  }

  const sort = firstOr(settings.sort, 'top');
  const timeframe = firstOr(settings.timeframe, 'day') as
    | 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  const limitPerSource = toInt(settings.limitPerSource, 25);
  const maxPerRun = toInt(settings.maxPerRun, 3);
  const mode = firstOr(settings.repostMode, 'crosspost');
  const disclose = settings.discloseBot !== false;
  const disclosureText =
    (settings.disclosureText as string) || '🤖 Reposted automatically by a bot.';

  let reposted = 0;

  for (const srcSub of sourceSubs) {
    if (reposted >= maxPerRun) break;

    let posts;
    try {
      posts = await fetchPosts(context, srcSub, sort, timeframe, limitPerSource);
    } catch (e) {
      console.error(`fetch r/${srcSub} failed: ${String(e)}`);
      continue; // one dead source never kills the run
    }

    for (const post of posts) {
      if (reposted >= maxPerRun) break;
      if (!isImagePost(post.url)) continue;

      // Dedup: skip if we've already reposted this source post to this target.
      const dedupKey = `seen:${targetSub}`;
      if (await context.redis.hGet(dedupKey, post.id)) continue;

      try {
        const newPost =
          mode === 'link'
            ? await context.reddit.submitPost({
                subredditName: targetSub,
                title: post.title,
                url: post.url,
              })
            : await context.reddit.crosspost({
                subredditName: targetSub,
                postId: post.id,
                title: post.title,
              });

        await context.redis.hSet(dedupKey, { [post.id]: '1' });
        await context.redis.expire(dedupKey, DEDUP_TTL_SECONDS);

        if (disclose && newPost?.id) {
          try {
            await context.reddit.submitComment({ id: newPost.id, text: disclosureText });
          } catch (e) {
            console.error(`disclosure comment failed: ${String(e)}`);
          }
        }

        reposted++;
        console.log(`reposted ${post.id} (r/${srcSub}) -> r/${targetSub}`);
      } catch (e) {
        console.error(`repost ${post.id} failed: ${String(e)}`);
      }
    }
  }

  console.log(`run complete: ${reposted} reposted to r/${targetSub}`);
}

async function fetchPosts(
  context: JobContext,
  subredditName: string,
  sort: string,
  timeframe: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all',
  limit: number,
) {
  if (sort === 'hot') {
    return context.reddit.getHotPosts({ subredditName, limit }).all();
  }
  if (sort === 'new') {
    return context.reddit.getNewPosts({ subredditName, limit }).all();
  }
  return context.reddit.getTopPosts({ subredditName, timeframe, limit }).all();
}

function isImagePost(url: string | undefined): boolean {
  if (!url) return false;
  return (
    /\.(jpe?g|png|gif)(\?.*)?$/i.test(url) ||
    /\/\/i\.redd\.it\//i.test(url) ||
    url.includes('/gallery/')
  );
}

function parseSubs(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim().replace(/^\/?r\//i, ''))
    .filter(Boolean);
}

function firstOr(value: unknown, fallback: string): string {
  if (Array.isArray(value)) return (value[0] as string) ?? fallback;
  if (typeof value === 'string') return value || fallback;
  return fallback;
}

function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export default Devvit;
