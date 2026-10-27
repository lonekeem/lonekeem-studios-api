import { applyCors, send } from '../lib/http.js';
import { env, MODELS, DEFAULT_MODEL, ASPECTS, DEFAULT_ASPECT, REAL_MAX_LENGTH } from '../lib/config.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  res.setHeader('Cache-Control', 'public, max-age=300');
  send(res, 200, {
    generation_mode: env.generationMode(),
    default_model: DEFAULT_MODEL,
    owner_real: { models: env.realModels(), default_model: env.realModels()[0], max_length_s: REAL_MAX_LENGTH, daily_cap: env.ownerDailyRealCap() },
    aspect_ratios: ASPECTS,
    default_aspect_ratio: DEFAULT_ASPECT,
    models: Object.entries(MODELS).map(([id, m]) => ({
      id, label: m.label, endpoint: m.endpoint, lengths: m.lengths, price_reels: m.price,
      quality: id === 'hailuo' ? '768p' : '480p',
      real_allowed: env.realModels().includes(id),
    })),
  });
}
