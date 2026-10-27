import { applyCors, send, methodGuard, readJson, bearer } from '../lib/http.js';
import { MODELS, DEFAULT_MODEL, ASPECTS, DEFAULT_ASPECT, MAX_PROMPT, REAL_MAX_LENGTH, resolveLength, env } from '../lib/config.js';
import { isOwner, generationModeFor } from '../lib/owner.js';
import { getUser, serverRpc } from '../lib/supabase.js';
import { moderate } from '../lib/moderation.js';
import * as fal from '../lib/fal.js';
import { webhookToken } from '../lib/webhook-token.js';
import { DEMO_PREFIX, isBillingError } from '../lib/demo.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!methodGuard(req, res, ['POST'])) return;

  const user = await getUser(bearer(req));
  if (!user) return send(res, 401, { error: 'unauthorized', message: 'Send a Supabase access token: Authorization: Bearer <jwt>' });

  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'invalid_json' });

  const prompt = String(body.prompt || '').trim();
  if (!prompt) return send(res, 400, { error: 'prompt_required' });
  if (prompt.length > MAX_PROMPT) return send(res, 400, { error: 'prompt_too_long', max: MAX_PROMPT });

  // Everyone gets demo clips; only owners (OWNER_USER_IDS / OWNER_EMAILS) with REAL_FOR_OWNERS on get real fal clips.
  const owner = isOwner(user);
  const mode = generationModeFor(user);
  const real = mode === 'real';

  // Real mode: cheapest model by default, owner may pick from the real allowlist.
  const realModels = env.realModels();
  const defaultModel = real ? realModels[0] : DEFAULT_MODEL;
  const modelId = body.model && MODELS[body.model] ? body.model : body.model ? null : defaultModel;
  if (!modelId) return send(res, 400, { error: 'unknown_model', models: Object.keys(MODELS) });
  if (real && !realModels.includes(modelId)) {
    return send(res, 400, { error: 'model_not_allowed', message: `Real clips can use: ${realModels.join(', ')}`, models: realModels });
  }
  const model = MODELS[modelId];
  // Real clips are hard-capped at 5 s (one short clip per generation).
  const length = real ? Math.min(REAL_MAX_LENGTH, Math.min(...model.lengths)) : resolveLength(modelId, body.length);
  const aspect = ASPECTS.includes(body.aspect_ratio) ? body.aspect_ratio : DEFAULT_ASPECT;
  const quality = modelId === 'hailuo' ? '768p' : '480p';
  const cost = model.price[length];
  const characterId = typeof body.character_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.character_id) ? body.character_id : null;

  const mod = await moderate(prompt);
  if (!mod.allowed) return send(res, 422, { error: 'prompt_rejected', reason: mod.reason });

  // Atomically: rate-limit check + reel deduction + clip row (status queued)
  let start;
  try {
    start = await serverRpc('start_generation', {
      p_user: user.id, p_prompt: prompt, p_model: modelId, p_endpoint: model.endpoint, p_length: length,
      p_quality: quality, p_aspect: aspect, p_cost: cost, p_daily_limit: env.dailyLimit(), p_character_id: characterId,
      p_real: real, p_real_cap: env.ownerDailyRealCap(),
    });
  } catch (e) {
    console.error('start_generation', e.status, e.message);
    return send(res, 500, { error: 'server_error' });
  }
  if (!start.ok) {
    const code = start.error === 'rate_limited' || start.error === 'owner_real_cap_reached' ? 429 : start.error === 'insufficient_reels' ? 402 : 400;
    return send(res, code, start);
  }

  const clipId = start.clip_id;
  const accepted = (status = 'queued') => send(res, 202, {
    clip: { id: clipId, status, model: modelId, length, quality, aspect_ratio: aspect, cost, demo: !real },
    mode,
    owner,
    ...(real ? { real_used_24h: start.real_used_24h, real_cap: start.real_cap } : {}),
    balance: start.balance,
    generations_used_24h: start.used_24h,
    daily_limit: start.limit,
    poll: `/api/status?id=${clipId}`,
  });

  if (!real) {
    // Same queue/status flow, but the "provider" is a built-in sample clip (no fal call, no cost).
    try {
      await serverRpc('set_clip_request', { p_clip: clipId, p_request_id: `${DEMO_PREFIX}${Date.now()}`, p_status: 'queued' });
      return accepted();
    } catch (e) {
      console.error('demo set_clip_request', e.status, e.message);
      const fin = await serverRpc('finish_clip', { p_clip: clipId, p_status: 'failed', p_error: 'demo_start_failed' }).catch(() => null);
      return send(res, 500, { error: 'server_error', clip: { id: clipId, status: 'failed' }, balance: fin?.balance });
    }
  }
  const base = env.publicBaseUrl();
  const webhookUrl = base ? `${base}/api/fal-webhook?clip=${clipId}&t=${webhookToken(clipId)}` : null;

  try {
    const sub = await fal.submit(model.endpoint, model.buildInput({ prompt, length, aspect }), webhookUrl);
    await serverRpc('set_clip_request', { p_clip: clipId, p_request_id: sub.request_id, p_status: 'queued' });
    return accepted();
  } catch (e) {
    console.error('fal submit', e.status, e.detail);
    const billing = isBillingError(e.status, e.detail);
    const fin = await serverRpc('finish_clip', { p_clip: clipId, p_status: 'failed', p_error: billing ? 'real_generation_not_enabled' : `provider_submit_failed:${e.status || ''}` }).catch(() => null);
    if (billing) return send(res, 503, { ...NOT_ENABLED, refunded: true, clip: { id: clipId, status: 'failed' }, balance: fin?.balance });
    return send(res, 502, {
      error: 'provider_error', message: 'Could not start generation; reels refunded.',
      clip: { id: clipId, status: 'failed' }, balance: fin && fin.balance != null ? fin.balance : undefined,
    });
  }
}

const NOT_ENABLED = {
  error: 'real_generation_not_enabled',
  message: 'Real AI video generation is not enabled yet. Your reels were not spent (or have been refunded). Demo mode still works.',
};
