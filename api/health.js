import { applyCors, send } from '../lib/http.js';
import { env, MODELS, DEFAULT_MODEL } from '../lib/config.js';

export default function handler(req, res) {
  if (applyCors(req, res)) return;
  send(res, 200, {
    ok: true,
    service: 'lonekeem-studios-api',
    time: new Date().toISOString(),
    config: {
      supabase: !!(env.supabaseUrl() && env.anonKey()),
      server_auth: env.serviceKey() ? 'service_role' : env.serverSecret() ? 'server_secret' : 'missing',
      generation_mode: env.generationMode(),
      fal: !!env.falKey(),
      daily_generation_limit: env.dailyLimit(),
    },
    default_model: DEFAULT_MODEL,
    models: Object.keys(MODELS),
  });
}
