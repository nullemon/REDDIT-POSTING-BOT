// D1 query helpers for the `posted` history table.

import { hamming } from './dedup';
import { log } from './log';
import type { SourceType } from './types';

export interface PostedRow {
  source_type: SourceType;
  source_id: string;
  dhash: string | null;
  image_url: string;
  target_sub: string;
  reddit_post_id: string;
  posted_at: number;
}

/**
 * Exact-match dedup: have we already posted this exact source_id to this target?
 * Scoped per-target so that `routing_mode: "all"` can legitimately fan one item
 * out to several subs, while still blocking re-posts of the same item to the
 * same sub on later cron fires.
 */
export async function alreadyPosted(
  db: D1Database,
  sourceId: string,
  targetSub: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM posted WHERE source_id = ? AND target_sub = ? LIMIT 1')
    .bind(sourceId, targetSub)
    .first();
  return row != null;
}

/**
 * Perceptual dedup: is there a recently-posted image to this target whose dhash
 * is within `threshold` Hamming distance? Bounded to the most recent N rows for
 * this target to stay inside Worker CPU limits.
 */
export async function hasSimilarDhash(
  db: D1Database,
  dhash: string,
  targetSub: string,
  threshold: number,
  limit = 500,
): Promise<boolean> {
  const { results } = await db
    .prepare(
      `SELECT dhash FROM posted
       WHERE target_sub = ? AND dhash IS NOT NULL
       ORDER BY posted_at DESC
       LIMIT ?`,
    )
    .bind(targetSub, limit)
    .all<{ dhash: string }>();

  for (const r of results ?? []) {
    if (r.dhash && hamming(dhash, r.dhash) <= threshold) return true;
  }
  return false;
}

export async function recordPost(db: D1Database, row: PostedRow): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO posted
           (source_type, source_id, dhash, image_url, target_sub, reddit_post_id, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.source_type,
        row.source_id,
        row.dhash,
        row.image_url,
        row.target_sub,
        row.reddit_post_id,
        row.posted_at,
      )
      .run();
  } catch (e) {
    // A failed history write must not crash the run; just log loudly. Worst case
    // we might re-post on a later fire (dedup relies on this row existing).
    log.error('db.recordPost failed', { error: String(e), source_id: row.source_id });
  }
}
