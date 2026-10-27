# lonekeem-studios-api

Backend for **Lone Keem Studios** (AI short-series app). Vercel serverless functions (Node 20, zero dependencies) + Supabase (auth, Postgres with RLS, storage) + fal.ai (video generation queue).

- API base URL: `https://lonekeem-studios-api.vercel.app` (Vercel Hobby project `lonekeem-studios-api`)
- Supabase project: `wwdwbnhswynjcxeerdgz` (us-east-1) — `https://wwdwbnhswynjcxeerdgz.supabase.co`
- Schema/migrations: [`supabase/migrations/`](supabase/migrations)

---

## Frontend integration guide

### 1. Config the frontend needs (public, safe to ship)

```js
// e.g. src/config.js  (or Vite env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_API_BASE)
export const SUPABASE_URL = 'https://wwdwbnhswynjcxeerdgz.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZHdibmhzd3luamN4ZWVyZGd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNjIyMjEsImV4cCI6MjEwODYzODIyMX0.f6eeihQmytwgDiJOFZjgHLeKq5GGFRZ0X9RqgP7bu_Q';
// (new-style publishable key also works: sb_publishable_Lr8VClcrLGY57mypsUP09A_Y5YRhOag)
export const API_BASE = 'https://lonekeem-studios-api.vercel.app';
```

Never put the service-role key, `API_SERVER_SECRET` or `FAL_KEY` in the frontend.

### 2. Auth with supabase-js

```bash
npm i @supabase/supabase-js
```

```js
import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Email magic link (GitHub Pages needs the full path as redirect)
await supabase.auth.signInWithOtp({
  email,
  options: { emailRedirectTo: 'https://lonekeem.github.io/lonekeem-studios/' },
});

// Google (works once Google OAuth is enabled in the Supabase dashboard)
await supabase.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: 'https://lonekeem.github.io/lonekeem-studios/' },
});

supabase.auth.onAuthStateChange((_event, session) => { /* update UI */ });
const { data: { session } } = await supabase.auth.getSession();
```

On first sign-in a DB trigger creates the user's `profiles` row (auto `@handle` from the email) and a balance of **500 reels**.

Helper for calling this API:

```js
async function api(path, { method = 'GET', body } = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.error || r.statusText), { status: r.status, body: json });
  return json;
}
```

CORS allows `https://lonekeem.github.io`, `capacitor://localhost`, `ionic://localhost`, `http(s)://localhost[:port]`, `http://127.0.0.1[:port]`.

### 3. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | – | Liveness + which integrations are configured |
| GET | `/api/models` | – | Model list, lengths, reel prices |
| GET | `/api/me` | Bearer | Profile, reel balance, daily-claim availability, usage |
| POST | `/api/generate` | Bearer | Start a clip (moderation → rate limit → deduct reels → fal queue) |
| GET | `/api/status?id=<clip id>` | Bearer | Poll a clip; finalises it (stores video, refunds on failure) |
| POST | `/api/claim-daily` | Bearer | +50 reels once per UTC day |
| POST | `/api/fal-webhook` | HMAC token | Called by fal when a job finishes (not for the frontend) |

#### `GET /api/models` → 200
```json
{
  "default_model": "fast",
  "aspect_ratios": ["9:16", "16:9", "1:1"],
  "default_aspect_ratio": "9:16",
  "models": [
    { "id": "fast", "label": "Fast (Wan 2.2 FastWan 5B)", "endpoint": "fal-ai/wan/v2.2-5b/text-to-video/fast-wan", "lengths": [5, 10], "price_reels": { "5": 5, "10": 10 }, "quality": "480p" }
  ]
}
```

Current catalog (all 480p except Hailuo, which is fixed 768p; prices ≈ 1 reel per $0.01 of fal cost):

| id | fal endpoint | lengths | reels (5s / 10s) |
|---|---|---|---|
| `fast` (default, cheapest) | `fal-ai/wan/v2.2-5b/text-to-video/fast-wan` | 5, 10 | 5 / 10 |
| `seedance` | `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video` | 5, 10 | 8 / 15 |
| `seedance2` | `bytedance/seedance-2.0/fast/text-to-video` | 5, 10 | 60 / 115 |
| `wan` | `fal-ai/wan-25-preview/text-to-video` | 5, 10 | 30 / 55 |
| `hailuo` | `fal-ai/minimax/hailuo-02/standard/text-to-video` | 6, 10 | 30 (6s) / 50 |
| `kling` | `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` | 5, 10 | 40 / 75 |

Edit `lib/config.js` to change models or prices.

#### `POST /api/generate`
Request:
```json
{ "prompt": "Keem walks into a neon diner, rain outside", "model": "fast", "length": 5, "aspect_ratio": "9:16", "character_id": null }
```
`model` defaults to `fast`; `length` snaps to the nearest supported length; `aspect_ratio` defaults to `9:16`.

Responses:
- `202` started:
  ```json
  { "clip": { "id": "uuid", "status": "queued", "model": "fast", "length": 5, "quality": "480p", "aspect_ratio": "9:16", "cost": 5 },
    "balance": 495, "generations_used_24h": 1, "daily_limit": 10, "poll": "/api/status?id=uuid" }
  ```
- `401 {"error":"unauthorized"}` – missing/invalid Supabase token
- `400 {"error":"prompt_required" | "prompt_too_long" | "unknown_model" | "invalid_json"}`
- `422 {"error":"prompt_rejected","reason":"blocked_terms"}` – moderation
- `402 {"ok":false,"error":"insufficient_reels","balance":3,"cost":5}`
- `429 {"ok":false,"error":"rate_limited","used_24h":10,"limit":10,"balance":…}` – default 10 generations / user / rolling 24h
- `503 {"error":"generation_unavailable"}` – FAL_KEY not configured (no reels charged)
- `502 {"error":"provider_error","clip":{"id":…,"status":"failed"},"balance":…}` – fal rejected the job; reels already refunded

#### `GET /api/status?id=<clip id>`
Poll every ~3–5 s until `status` is `done` or `failed`.
```json
{ "clip": { "id": "uuid", "status": "queued|running|done|failed", "model": "fast", "prompt": "…", "length": 5,
            "quality": "480p", "aspect_ratio": "9:16", "cost": 5, "refunded": false,
            "video_url": "https://wwdwbnhswynjcxeerdgz.supabase.co/storage/v1/object/public/clips/<uid>/<clip>.mp4",
            "storage_path": "<uid>/<clip>.mp4", "error": null, "character_id": null,
            "created_at": "…", "updated_at": "…" },
  "provider": { "status": "IN_QUEUE|IN_PROGRESS", "queue_position": 2 } }
```
When done, the video is copied into the public `clips` bucket (≤50 MB); if that copy fails, `video_url` is the fal CDN URL. Failed or timed-out (60 min) clips are refunded automatically (`refunded: true`).

#### `POST /api/claim-daily`
- `200 {"ok":true,"granted":50,"balance":545,"next_claim_at":"2026-10-28T00:00:00+00:00"}`
- `409 {"ok":false,"error":"already_claimed","balance":545,"next_claim_at":"…"}`

(Equivalent: `await supabase.rpc('claim_daily')`.)

#### `GET /api/me`
```json
{ "user": { "id": "uuid", "email": "…" }, "profile": { "handle": "keem", "display_name": "Keem", "avatar_url": null },
  "balance": 500, "daily_claim_available": true, "generations_used_24h": 0, "daily_limit": 10 }
```

### 4. Direct Supabase access (supabase-js, RLS-enforced)

Everything except generation/credits is plain supabase-js CRUD:

| Table | Read | Write (signed-in user) |
|---|---|---|
| `profiles` (id, handle unique `^[a-z0-9_]{3,24}$`, display_name, avatar_url) | everyone | update own |
| `characters` (owner_id, name, handle unique, age ≥18, traits text[], bio, socials jsonb, collab_mode `allow|request|private`, look_prompt, portrait_url, voice_settings jsonb, lore jsonb) | non-private, or own | CRUD own (`owner_id` = your uid) |
| `series` (owner_id, title, description, cover_url, character_ids uuid[], is_public) | public or own | CRUD own |
| `episodes` (series_id, owner_id, number, title, clip_ids uuid[] **ordered**, is_public) | public or own | CRUD own, in own series |
| `clips` | public or own | update `is_public`/`character_id`, delete own. **Create only via `/api/generate`** |
| `credit_balances` (balance, last_daily_claim) / `credit_ledger` | own | none (server only) |
| `likes` (user_id, target_type `clip|episode|series|character`, target_id) | everyone | insert/delete own |
| `follows` (follower_id, followee_id) | everyone | insert/delete own |
| `reports` (reporter_id, target_type, target_id, reason) | own | insert own |
| `blocks` (blocker_id, blocked_id) | own | insert/delete own |
| `remix_requests` (requester_id, character_id, owner_id, message, status `pending|approved|denied|cancelled`) | requester or owner | requester inserts (character must be `collab_mode='request'`), either side updates |

```js
const { data: { user } } = await supabase.auth.getUser();
await supabase.from('characters').insert({ owner_id: user.id, name: 'Nova', handle: 'nova', traits: ['brave'], collab_mode: 'request' });
const { data: balance } = await supabase.from('credit_balances').select('balance').single();
```

Storage buckets (public read): `portraits` (images ≤5 MB) and `clips` (video ≤50 MB). Upload to `<your uid>/<file>`:
```js
await supabase.storage.from('portraits').upload(`${user.id}/${characterId}.png`, file, { upsert: true });
const url = supabase.storage.from('portraits').getPublicUrl(`${user.id}/${characterId}.png`).data.publicUrl;
```

---

## Server setup

Env vars (Vercel → Project → Settings → Environment Variables):

| Var | Required | Notes |
|---|---|---|
| `SUPABASE_URL` | yes | `https://wwdwbnhswynjcxeerdgz.supabase.co` |
| `SUPABASE_ANON_KEY` | yes | public anon key |
| `API_SERVER_SECRET` | yes* | 64-hex secret; `sha256` stored in `private.app_config.server_secret_sha256`. Lets the API call the privileged DB functions |
| `SUPABASE_SERVICE_ROLE_KEY` | optional* | if set, used instead of the server secret (*one of the two is required) |
| `FAL_KEY` | for generation | fal.ai API key (sensitive) |
| `DAILY_GENERATION_LIMIT` | optional | default 10 |
| `PUBLIC_BASE_URL` | optional | for fal webhooks; defaults to the Vercel production URL |
| `MODERATION_WEBHOOK_URL` | optional | hook for a real moderation model: POST `{text}` → `{allowed, reason}` |

Rotate the server secret: generate a new 64-hex value, set `API_SERVER_SECRET` in Vercel, and run
`update private.app_config set value = encode(extensions.digest('<new secret>', 'sha256'), 'hex') where key = 'server_secret_sha256';`

### Security model
- Clients can never insert clips or change balances (table grants revoked; RLS read-only).
- `start_generation`, `set_clip_request`, `finish_clip`, `get_clip_server` are `SECURITY DEFINER` RPCs that only run for the service role or a caller presenting the server secret (Supabase's linter flags them as anon-callable; that is expected).
- Reel deduction + per-user rate limit happen in one transaction with a row lock on the user's balance; refunds happen at most once per clip.
- fal webhooks are authenticated with a per-clip HMAC token in the callback URL.

### Local dev
```bash
npm i -g vercel && vercel dev   # needs the env vars above in .env
npm test
```
