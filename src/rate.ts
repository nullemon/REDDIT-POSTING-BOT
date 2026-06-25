// KV-backed scheduling + rate limiting helpers.
//
// Keys used in the STATE namespace:
//   lastrun:<sourceKey>   -> epoch ms of the last successful fetch for a source
//   rate:<sub>:<hourBkt>  -> integer counter of posts to <sub> in that hour bucket
//   token:reddit          -> cached OAuth token (managed in reddit/auth.ts)

import { log } from './log';

/** Stable key for per-source poll state. */
export function sourceKey(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(':');
}

export async function isSourceDue(
  kv: KVNamespace,
  key: string,
  pollIntervalMin: number,
  now: number,
): Promise<boolean> {
  if (!pollIntervalMin || pollIntervalMin <= 0) return true; // 0 == every fire
  const raw = await kv.get(`lastrun:${key}`);
  if (!raw) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  return now - last >= pollIntervalMin * 60_000;
}

export async function markSourceRun(
  kv: KVNamespace,
  key: string,
  now: number,
): Promise<void> {
  // Keep the marker around well beyond any poll interval.
  await kv.put(`lastrun:${key}`, String(now), { expirationTtl: 60 * 60 * 24 * 7 });
}

function hourBucket(now: number): string {
  return String(Math.floor(now / 3_600_000)); // hours since epoch
}

/**
 * Atomically-ish check + reserve a posting slot for `sub` in the current hour.
 * KV is eventually consistent and has no real atomic increment, so this is a
 * best-effort cap (good enough for a single-Worker cron that runs serially).
 * Returns true if a slot was reserved, false if the hourly cap is reached.
 */
export async function reservePostSlot(
  kv: KVNamespace,
  sub: string,
  maxPerHour: number,
  now: number,
): Promise<boolean> {
  const key = `rate:${sub}:${hourBucket(now)}`;
  const raw = await kv.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= maxPerHour) {
    log.warn('hourly cap reached', { sub, count, maxPerHour });
    return false;
  }
  // TTL of 2 hours so buckets self-expire.
  await kv.put(key, String(count + 1), { expirationTtl: 7200 });
  return true;
}

/** Roll back a reserved slot if the post ultimately failed. Best-effort. */
export async function releasePostSlot(
  kv: KVNamespace,
  sub: string,
  now: number,
): Promise<void> {
  const key = `rate:${sub}:${hourBucket(now)}`;
  const raw = await kv.get(key);
  const count = raw ? Number(raw) : 0;
  if (count > 0) {
    await kv.put(key, String(count - 1), { expirationTtl: 7200 });
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff for transient failures (esp. Reddit 429).
 * attempt is 0-based: 0 -> base, 1 -> base*2, 2 -> base*4 ... capped.
 */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * Math.pow(2, attempt));
}
