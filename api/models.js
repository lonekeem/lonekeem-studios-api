import { applyCors, send } from '../lib/http.js';
import { MODELS, DEFAULT_MODEL, ASPECTS, DEFAULT_ASPECT } from '../lib/config.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  res.setHeader('Cache-Control', 'public, max-age=300');
  send(res, 200, {
    default_model: DEFAULT_MODEL,
    aspect_ratios: ASPECTS,
    default_aspect_ratio: DEFAULT_ASPECT,
    models: Object.entries(MODELS).map(([id, m]) => ({
      id, label: m.label, endpoint: m.endpoint, lengths: m.lengths, price_reels: m.price,
      quality: id === 'hailuo' ? '768p' : '480p',
    })),
  });
}
