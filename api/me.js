import { applyCors, send, methodGuard, bearer } from '../lib/http.js';
import { getUser, getBalance, userRest, serverRpc } from '../lib/supabase.js';
import { isOwner, generationModeFor } from '../lib/owner.js';
import { env } from '../lib/config.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!methodGuard(req, res, ['GET'])) return;
  const jwt = bearer(req);
  const user = await getUser(jwt);
  if (!user) return send(res, 401, { error: 'unauthorized' });
  const [bal, prof, used] = await Promise.all([
    getBalance(jwt, user.id),
    userRest(jwt, `/rest/v1/profiles?id=eq.${user.id}&select=handle,display_name,avatar_url`),
    userRest(jwt, `/rest/v1/clips?owner_id=eq.${user.id}&created_at=gt.${new Date(Date.now() - 864e5).toISOString()}&refunded=eq.false&select=id`),
  ]);
  const owner = isOwner(user);
  let realUsed = null;
  if (owner) realUsed = await serverRpc('real_usage', { p_user: user.id }).catch(() => null);
  const today = new Date().toISOString().slice(0, 10);
  send(res, 200, {
    user: { id: user.id, email: user.email },
    profile: prof.ok && prof.data[0] ? prof.data[0] : null,
    balance: bal.balance,
    daily_claim_available: bal.last_daily_claim !== today,
    generations_used_24h: Array.isArray(used.data) ? used.data.length : 0,
    daily_limit: env.dailyLimit(),
    owner,
    generation_mode: generationModeFor(user),
    ...(owner ? { real: {
      enabled: env.realForOwners(), fal_configured: !!env.falKey(),
      used_24h: typeof realUsed === 'number' ? realUsed : null, cap: env.ownerDailyRealCap(),
      models: env.realModels(), max_length_s: 5,
    } } : {}),
  });
}
