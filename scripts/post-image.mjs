#!/usr/bin/env node
// Standalone "post one image to Reddit" tester — plain Node 18+ (global fetch,
// FormData, Blob). Mirrors src/reddit/post.ts but runs locally so you can verify
// your credentials and the 4-step image flow WITHOUT deploying the Worker.
//
// Usage:
//   node scripts/post-image.mjs <subreddit> <imageUrlOrLocalPath> "<title>" [--comment "text"]
//
// Examples:
//   node scripts/post-image.mjs test "https://i.redd.it/abc.jpg" "Hello from the bot"
//   node scripts/post-image.mjs test ./photo.png "Local upload" --comment "🤖 bot post"
//
// Credentials are read from the environment, or from a local `.dev.vars` file if
// present (same keys you'd use for `wrangler secret put`):
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER, REDDIT_PASS, REDDIT_USER_AGENT

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ---- tiny .dev.vars loader (KEY=VALUE lines) ------------------------------
async function loadDevVars() {
  if (!existsSync('.dev.vars')) return;
  const text = await readFile('.dev.vars', 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env/secret: ${name}`);
  return v;
}

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };

function detectFromMagic(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return { mime: 'image/png', ext: 'png' };
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  return null;
}

async function loadImage(src) {
  let bytes;
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { headers: { 'User-Agent': 'post-image-tester/1.0' } });
    if (!r.ok) throw new Error(`image fetch failed: HTTP ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } else {
    bytes = new Uint8Array(await readFile(src));
  }
  const magic = detectFromMagic(bytes);
  if (magic) return { bytes, ...magic };
  // fall back to extension
  const m = src.toLowerCase().match(/\.(jpe?g|png|gif)(?:[?#].*)?$/);
  const ext = m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'jpg';
  return { bytes, ext, mime: MIME_BY_EXT[ext] || 'image/jpeg' };
}

// ---- STEP 1: OAuth password grant -----------------------------------------
async function getToken() {
  const basic = btoa(`${need('REDDIT_CLIENT_ID')}:${need('REDDIT_CLIENT_SECRET')}`);
  const body = new URLSearchParams({
    grant_type: 'password',
    username: need('REDDIT_USER'),
    password: need('REDDIT_PASS'),
  });
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': need('REDDIT_USER_AGENT'),
    },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`token HTTP ${r.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`no access_token: ${text}`);
  console.log('  ✓ step 1: got OAuth token');
  return json.access_token;
}

// ---- STEP 2: request the upload lease --------------------------------------
async function requestLease(token, ua, ext, mime) {
  const r = await fetch('https://oauth.reddit.com/api/media/asset.json', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
    },
    body: new URLSearchParams({ filepath: `image.${ext}`, mimetype: mime }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`asset.json HTTP ${r.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.args?.action || !json.args?.fields) throw new Error(`bad lease: ${text}`);
  console.log('  ✓ step 2: got S3 upload lease');
  return json;
}

// ---- STEP 3: upload the bytes to S3 ----------------------------------------
async function uploadToS3(lease, bytes, mime, ext) {
  const action = lease.args.action.startsWith('http') ? lease.args.action : `https:${lease.args.action}`;
  const form = new FormData();
  let key = '';
  for (const f of lease.args.fields) {
    if (f.name === 'key') key = f.value;
    form.append(f.name, f.value);
  }
  // file MUST be the last part
  form.append('file', new Blob([bytes], { type: mime }), `image.${ext}`);
  const r = await fetch(action, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`S3 upload HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  if (!key) throw new Error('lease had no "key" field');
  console.log('  ✓ step 3: uploaded image bytes to S3');
  return `${action}/${key}`;
}

// ---- STEP 4: submit the post -----------------------------------------------
async function submit(token, ua, sr, title, mediaUrl) {
  const r = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
    },
    body: new URLSearchParams({
      api_type: 'json',
      kind: 'image',
      sr,
      title: title.slice(0, 300),
      url: mediaUrl,
      resubmit: 'true',
      sendreplies: 'false',
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`submit HTTP ${r.status}: ${text}`);
  const json = JSON.parse(text);
  const errors = json?.json?.errors;
  if (Array.isArray(errors) && errors.length) throw new Error(`submit errors: ${JSON.stringify(errors)}`);
  console.log('  ✓ step 4: submit accepted');
  return json?.json?.data ?? {};
}

// Image posts process async, so the post id isn't always in the submit body.
// Poll the user's recent submissions to find the new post's fullname/permalink.
async function findNewPost(token, ua, user, title) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((res) => setTimeout(res, 2000));
    const r = await fetch(`https://oauth.reddit.com/user/${encodeURIComponent(user)}/submitted?limit=5&raw_json=1`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': ua },
    });
    if (!r.ok) continue;
    const json = await r.json();
    const children = json?.data?.children ?? [];
    const match = children.find((c) => c.data?.title === title) ?? children[0];
    if (match) {
      return { fullname: match.data.name, permalink: `https://www.reddit.com${match.data.permalink}` };
    }
  }
  return null;
}

async function comment(token, ua, fullname, text) {
  const r = await fetch('https://oauth.reddit.com/api/comment', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ua,
    },
    body: new URLSearchParams({ api_type: 'json', thing_id: fullname, text }),
  });
  if (!r.ok) { console.warn(`  ! disclosure comment failed: HTTP ${r.status}`); return; }
  console.log('  ✓ disclosure comment posted');
}

async function main() {
  await loadDevVars();

  const argv = process.argv.slice(2);
  const commentIdx = argv.indexOf('--comment');
  let commentText = null;
  if (commentIdx !== -1) {
    commentText = argv[commentIdx + 1];
    argv.splice(commentIdx, 2);
  }
  const [sr, imageSrc, title] = argv;
  if (!sr || !imageSrc || !title) {
    console.error('usage: node scripts/post-image.mjs <subreddit> <imageUrlOrPath> "<title>" [--comment "text"]');
    process.exit(1);
  }

  const ua = need('REDDIT_USER_AGENT');
  console.log(`Posting to r/${sr}: "${title}"`);

  const img = await loadImage(imageSrc);
  console.log(`  image: ${img.bytes.length} bytes, ${img.mime}`);

  const token = await getToken();
  const lease = await requestLease(token, ua, img.ext, img.mime);
  const mediaUrl = await uploadToS3(lease, img.bytes, img.mime, img.ext);
  await submit(token, ua, sr, title, mediaUrl);

  const post = await findNewPost(token, ua, need('REDDIT_USER'), title);
  if (post) {
    console.log(`\n✅ Posted: ${post.permalink}`);
    if (commentText) await comment(token, ua, post.fullname, commentText);
  } else {
    console.log('\n✅ Submit accepted (post is processing — check your profile to confirm).');
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exit(1);
});
