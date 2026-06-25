// Reddit OAuth — script app, password grant, with KV token caching + refresh.
//
// PRAW does not exist on Workers, so we talk raw REST. A "script" type app
// (https://www.reddit.com/prefs/apps) uses the resource-owner password grant:
// we exchange client_id/secret + username/password for a bearer token, cache it
// in KV until shortly before it expires, and force a refresh on any 401.

import { log } from '../log';
import type { Env } from '../types';

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const TOKEN_KV_KEY = 'token:reddit';
const SAFETY_MARGIN_MS = 60_000; // refresh a minute before actual expiry

interface CachedToken {
  access_token: string;
  expires_at: number; // epoch ms
}

/**
 * Return a valid bearer token, using the KV cache when possible.
 * Pass forceRefresh=true (e.g. after a 401) to bypass the cache.
 */
export async function getRedditToken(env: Env, forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = await readCachedToken(env);
    if (cached && cached.expires_at - SAFETY_MARGIN_MS > Date.now()) {
      return cached.access_token;
    }
  }
  return mintToken(env);
}

async function readCachedToken(env: Env): Promise<CachedToken | null> {
  const raw = await env.STATE.get(TOKEN_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedToken;
  } catch {
    return null;
  }
}

async function mintToken(env: Env): Promise<string> {
  // HTTP Basic auth with the app's client_id:client_secret.
  const basic = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`);

  const body = new URLSearchParams({
    grant_type: 'password',
    username: env.REDDIT_USER,
    password: env.REDDIT_PASS,
  });

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      // Reddit REQUIRES a descriptive, unique User-Agent or it will 429/403 you.
      'User-Agent': env.REDDIT_USER_AGENT,
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`reddit token mint failed: HTTP ${resp.status} ${text}`);
  }

  let json: { access_token?: string; expires_in?: number; error?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`reddit token response not JSON: ${text}`);
  }
  if (!json.access_token) {
    throw new Error(`reddit token response missing access_token: ${text}`);
  }

  const expiresInMs = (json.expires_in ?? 3600) * 1000;
  const cached: CachedToken = {
    access_token: json.access_token,
    expires_at: Date.now() + expiresInMs,
  };

  // Cache in KV with a TTL slightly under the real expiry.
  const ttl = Math.max(60, Math.floor(expiresInMs / 1000) - 120);
  await env.STATE.put(TOKEN_KV_KEY, JSON.stringify(cached), { expirationTtl: ttl });

  log.info('reddit token minted', { expires_in_s: Math.floor(expiresInMs / 1000) });
  return cached.access_token;
}
