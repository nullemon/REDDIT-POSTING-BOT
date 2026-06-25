// Target routing: turn a flat list of fetched items into concrete
// (item -> target subreddit) post plans, according to routing_mode.
//
//   mapping     : each item -> the targets configured on its own source
//   all         : each item -> EVERY target sub across all sources
//   round_robin : items distributed one-per-target across the global target set
//
// Duplicate (item, target) pairs are collapsed so the same image can't be
// queued to the same sub twice in one run.

import type { ImageItem, PostingConfig, RoutedPost } from './types';

export function routeItems(items: ImageItem[], cfg: PostingConfig): RoutedPost[] {
  const globalTargets = dedupe(items.flatMap((i) => i.targets));
  const planned: RoutedPost[] = [];

  switch (cfg.routing_mode) {
    case 'all': {
      for (const item of items) {
        for (const target of globalTargets) planned.push({ item, target });
      }
      break;
    }

    case 'round_robin': {
      if (globalTargets.length === 0) break;
      items.forEach((item, idx) => {
        const target = globalTargets[idx % globalTargets.length];
        planned.push({ item, target });
      });
      break;
    }

    case 'mapping':
    default: {
      for (const item of items) {
        for (const target of dedupe(item.targets)) planned.push({ item, target });
      }
      break;
    }
  }

  return collapsePairs(planned);
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

function collapsePairs(posts: RoutedPost[]): RoutedPost[] {
  const seen = new Set<string>();
  const out: RoutedPost[] = [];
  for (const p of posts) {
    const key = `${p.item.source_id}->${p.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
