// Reddit image posting — the real 4-step upload+submit flow, raw REST.
//
// This is the highest-risk part of the bot, so every step is documented inline.
// Reddit image posts are NOT a single call; you must lease an S3 upload slot,
// PUT the bytes to S3 yourself, then submit a link to the uploaded asset:
//
//   Step 1  POST https://www.reddit.com/api/v1/access_token   (see auth.ts)
//   Step 2  POST https://oauth.reddit.com/api/media/asset.json  -> upload lease
//   Step 3  POST <s3 lease url>  (multipart)                     -> store bytes
//   Step 4  POST https://oauth.reddit.com/api/submit  kind=image -> create post
//
// On top of that we optionally resolve the new post's fullname (t3_xxx) via the
// submit websocket so we can attach a bot-disclosure comment / flair.

import { log } from '../log';
import { backoffMs, sleep } from '../rate';
import type { Env, FetchedImage } from '../types';
import { getRedditToken } from './auth';

const OAUTH = 'https://oauth.reddit.com';

export interface SubmitResult {
  ok: boolean;
  postFullname?: string; // t3_xxxxx
  postId?: string;       // xxxxx
  postUrl?: string;
  error?: string;
}

interface UploadLease {
  args: {
    action: string; // e.g. "//reddit-uploaded-media.s3-accelerate.amazonaws.com"
    fields: { name: string; value: string }[];
  };
  asset: {
    asset_id: string;
    websocket_url?: string;
  };
}

/** Full 4-step flow. Returns the created post's fullname when resolvable. */
export async function submitImagePost(
  env: Env,
  target: string,
  title: string,
  img: FetchedImage,
): Promise<SubmitResult> {
  try {
    // ---- STEP 2: request an upload lease for this image's mime type --------
    const filename = `image.${img.ext}`;
    const lease = await requestUploadLease(env, filename, img.mime);

    // ---- STEP 3: upload the raw bytes to the S3 URL from the lease ---------
    const mediaUrl = await uploadToLease(lease, img, filename);

    // ---- STEP 4: submit the post, pointing `url` at the uploaded asset -----
    const result = await submitPost(env, target, title, mediaUrl, lease.asset.websocket_url);
    return result;
  } catch (e) {
    const error = String(e);
    log.error('submitImagePost failed', { target, error });
    return { ok: false, error };
  }
}

// ------------------------------------------------------------------ STEP 2 --
async function requestUploadLease(
  env: Env,
  filepath: string,
  mimetype: string,
): Promise<UploadLease> {
  const body = new URLSearchParams({ filepath, mimetype });
  const resp = await redditCall(env, (token) =>
    fetch(`${OAUTH}/api/media/asset.json`, {
      method: 'POST',
      headers: oauthHeaders(env, token, 'application/x-www-form-urlencoded'),
      body,
    }),
  );

  const text = await resp.text();
  if (!resp.ok) throw new Error(`asset.json HTTP ${resp.status}: ${text}`);

  const json = JSON.parse(text) as UploadLease;
  if (!json.args?.action || !json.args?.fields) {
    throw new Error(`asset.json missing lease args: ${text}`);
  }
  return json;
}

// ------------------------------------------------------------------ STEP 3 --
async function uploadToLease(
  lease: UploadLease,
  img: FetchedImage,
  filename: string,
): Promise<string> {
  // The lease "action" is usually protocol-relative; normalize to https.
  const action = lease.args.action.startsWith('http')
    ? lease.args.action
    : `https:${lease.args.action}`;

  // Build the multipart form: every signed field from the lease, IN ORDER,
  // and the file LAST (S3 requires the file to be the final part).
  const form = new FormData();
  let key = '';
  for (const f of lease.args.fields) {
    if (f.name === 'key') key = f.value;
    form.append(f.name, f.value);
  }
  form.append('file', new Blob([img.bytes], { type: img.mime }), filename);

  const up = await fetch(action, { method: 'POST', body: form });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    throw new Error(`S3 upload HTTP ${up.status}: ${t.slice(0, 300)}`);
  }

  // The publicly-addressable asset URL is action + "/" + key. This is what we
  // hand to /api/submit as the image `url`.
  if (!key) throw new Error('upload lease had no "key" field');
  return `${action}/${key}`;
}

// ------------------------------------------------------------------ STEP 4 --
async function submitPost(
  env: Env,
  sr: string,
  title: string,
  mediaUrl: string,
  websocketUrl?: string,
): Promise<SubmitResult> {
  const body = new URLSearchParams({
    api_type: 'json',
    kind: 'image',
    sr,
    title: title.slice(0, 300), // Reddit hard limit
    url: mediaUrl,
    resubmit: 'true',
    sendreplies: 'false',
  });

  const resp = await redditCall(env, (token) =>
    fetch(`${OAUTH}/api/submit`, {
      method: 'POST',
      headers: oauthHeaders(env, token, 'application/x-www-form-urlencoded'),
      body,
    }),
  );

  const text = await resp.text();
  if (!resp.ok) return { ok: false, error: `submit HTTP ${resp.status}: ${text}` };

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `submit response not JSON: ${text.slice(0, 300)}` };
  }

  const errors = json?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return { ok: false, error: `submit errors: ${JSON.stringify(errors)}` };
  }

  // The submit response sometimes contains the fullname/url directly; for image
  // posts it usually returns a websocket_url that fires once Reddit finishes
  // processing the upload and the post goes live.
  const data = json?.json?.data ?? {};
  let postUrl: string | undefined = data.url;
  let fullname: string | undefined = data.name; // t3_xxxxx when present

  const wsUrl = data.websocket_url || websocketUrl;
  if (!fullname && wsUrl) {
    const redirect = await waitForPostUrl(wsUrl);
    if (redirect) postUrl = redirect;
  }

  const postId = extractPostId(postUrl);
  if (postId && !fullname) fullname = `t3_${postId}`;

  log.info('reddit submit ok', { sr, postUrl: postUrl ?? null, fullname: fullname ?? null });
  return { ok: true, postFullname: fullname, postId: postId ?? undefined, postUrl };
}

// ---- bot disclosure -------------------------------------------------------

/** Post a top-level comment on a submission (used for bot disclosure). */
export async function postDisclosureComment(
  env: Env,
  postFullname: string,
  text: string,
): Promise<boolean> {
  const body = new URLSearchParams({ api_type: 'json', thing_id: postFullname, text });
  const resp = await redditCall(env, (token) =>
    fetch(`${OAUTH}/api/comment`, {
      method: 'POST',
      headers: oauthHeaders(env, token, 'application/x-www-form-urlencoded'),
      body,
    }),
  );
  if (!resp.ok) {
    log.warn('disclosure comment failed', { status: resp.status });
    return false;
  }
  return true;
}

/** Apply a link flair (text and/or template id) to a submission. Best-effort. */
export async function applyFlair(
  env: Env,
  sr: string,
  postFullname: string,
  flairText?: string,
  flairTemplateId?: string,
): Promise<boolean> {
  const body = new URLSearchParams({ api_type: 'json', link: postFullname });
  if (flairText) body.set('text', flairText);
  if (flairTemplateId) body.set('flair_template_id', flairTemplateId);

  const resp = await redditCall(env, (token) =>
    fetch(`${OAUTH}/r/${encodeURIComponent(sr)}/api/selectflair`, {
      method: 'POST',
      headers: oauthHeaders(env, token, 'application/x-www-form-urlencoded'),
      body,
    }),
  );
  if (!resp.ok) {
    log.warn('flair apply failed', { sr, status: resp.status });
    return false;
  }
  return true;
}

// ---- shared helpers -------------------------------------------------------

function oauthHeaders(env: Env, token: string, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'User-Agent': env.REDDIT_USER_AGENT,
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

/**
 * Wrapper around a Reddit OAuth call that auto-refreshes the token on 401 and
 * applies exponential backoff on 429. `makeReq` is called with a fresh token.
 */
async function redditCall(
  env: Env,
  makeReq: (token: string) => Promise<Response>,
  maxRetries = 3,
): Promise<Response> {
  let token = await getRedditToken(env);
  for (let attempt = 0; ; attempt++) {
    const resp = await makeReq(token);

    if (resp.status === 401 && attempt < maxRetries) {
      log.warn('reddit 401 -> refreshing token', { attempt });
      token = await getRedditToken(env, true); // force refresh
      continue;
    }
    if (resp.status === 429 && attempt < maxRetries) {
      const wait = backoffMs(attempt);
      log.warn('reddit 429 -> backing off', { attempt, wait });
      await sleep(wait);
      continue;
    }
    return resp;
  }
}

/**
 * Listen on the submit websocket for the "success" message that carries the
 * final post URL. Bounded by a timeout so it can never hang the run. Uses the
 * Cloudflare fetch()-based websocket client (wss:// -> https://).
 */
async function waitForPostUrl(websocketUrl: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const httpUrl = websocketUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const resp = await fetch(httpUrl, { headers: { Upgrade: 'websocket' } });
    const ws = (resp as unknown as { webSocket?: WebSocket }).webSocket;
    if (!ws) return null;

    ws.accept();
    return await new Promise<string | null>((resolve) => {
      const done = (val: string | null) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        resolve(val);
      };
      const timer = setTimeout(() => done(null), timeoutMs);

      ws.addEventListener('message', (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          const redirect: string | undefined = msg?.payload?.redirect;
          if (redirect) done(redirect);
        } catch {
          done(null);
        }
      });
      ws.addEventListener('error', () => done(null));
      ws.addEventListener('close', () => done(null));
    });
  } catch {
    return null;
  }
}

/** Pull the base36 post id out of a reddit comments URL. */
function extractPostId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/comments\/([a-z0-9]+)\//i);
  return m ? m[1] : null;
}
