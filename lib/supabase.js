import { env } from './config.js';

// Verify a Supabase access token by asking Supabase Auth who it belongs to.
export async function getUser(jwt) {
  if (!jwt) return null;
  const r = await fetch(`${env.supabaseUrl()}/auth/v1/user`, {
    headers: { apikey: env.anonKey(), Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

// Privileged RPC: uses the service role key when configured, otherwise the anon key + server secret
// (the DB functions accept either; see supabase/migrations/0002_*.sql).
export async function serverRpc(fn, args) {
  const key = env.serviceKey() || env.anonKey();
  const r = await fetch(`${env.supabaseUrl()}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: env.serverSecret() || null, ...args }),
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error(`rpc ${fn} failed: ${r.status} ${data && data.message ? data.message : ''}`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

// Calls made on behalf of the signed-in user (RLS applies).
export async function userRest(jwt, path, init = {}) {
  const r = await fetch(`${env.supabaseUrl()}${path}`, {
    ...init,
    headers: { apikey: env.anonKey(), Authorization: `Bearer ${jwt}`, ...(init.headers || {}) },
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: r.ok, status: r.status, data };
}

export async function getOwnClip(jwt, id) {
  const { ok, data } = await userRest(jwt, `/rest/v1/clips?id=eq.${encodeURIComponent(id)}&select=*`);
  return ok && Array.isArray(data) && data[0] ? data[0] : null;
}

export async function getBalance(jwt, userId) {
  const { ok, data } = await userRest(jwt, `/rest/v1/credit_balances?user_id=eq.${userId}&select=balance,last_daily_claim`);
  return ok && data && data[0] ? data[0] : { balance: 0, last_daily_claim: null };
}

// Copy a finished fal video into the public "clips" bucket at <uid>/<clipId>.mp4.
// Uses the service key if present, else the user's own JWT (storage RLS: owner folder).
export async function copyVideoToStorage({ jwt, userId, clipId, videoUrl, maxBytes = 50 * 1024 * 1024 }) {
  const key = env.serviceKey();
  const authToken = key || jwt;
  if (!authToken) return null;
  const src = await fetch(videoUrl);
  if (!src.ok) return null;
  const len = Number(src.headers.get('content-length') || 0);
  if (len && len > maxBytes) return null;
  const buf = Buffer.from(await src.arrayBuffer());
  if (buf.length > maxBytes) return null;
  const path = `${userId}/${clipId}.mp4`;
  const up = await fetch(`${env.supabaseUrl()}/storage/v1/object/clips/${path}`, {
    method: 'POST',
    headers: {
      apikey: key || env.anonKey(), Authorization: `Bearer ${authToken}`,
      'Content-Type': src.headers.get('content-type') || 'video/mp4', 'x-upsert': 'true',
    },
    body: buf,
  });
  if (!up.ok) return null;
  return { path, publicUrl: `${env.supabaseUrl()}/storage/v1/object/public/clips/${path}` };
}
