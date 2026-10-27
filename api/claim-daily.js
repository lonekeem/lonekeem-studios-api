import { applyCors, send, methodGuard, bearer } from '../lib/http.js';
import { userRest } from '../lib/supabase.js';

// +50 reels once per UTC day. Thin wrapper around the claim_daily() DB function
// (the frontend can also call supabase.rpc('claim_daily') directly).
export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!methodGuard(req, res, ['POST'])) return;
  const jwt = bearer(req);
  if (!jwt) return send(res, 401, { error: 'unauthorized' });
  const r = await userRest(jwt, '/rest/v1/rpc/claim_daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (r.status === 401 || r.status === 403 || (r.data && r.data.code === '42501')) return send(res, 401, { error: 'unauthorized' });
  if (!r.ok) return send(res, 500, { error: 'server_error' });
  return send(res, r.data.ok ? 200 : 409, r.data);
}
