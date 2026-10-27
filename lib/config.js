// Model catalog: app model choice -> real fal.ai endpoint IDs (verified against fal's live model list, Oct 2026).
// Reel prices are ~1 reel per US$0.01 of fal cost (rounded up), at 480p where the model supports it.
export const MODELS = {
  fast: {
    label: 'Fast (Wan 2.2 FastWan 5B)',
    endpoint: 'fal-ai/wan/v2.2-5b/text-to-video/fast-wan',
    lengths: [5, 10],
    price: { 5: 5, 10: 10 },
    // ~$0.025 per video at 720p, less at 480p
    buildInput: ({ prompt, length, aspect }) => ({
      prompt, resolution: '480p', aspect_ratio: aspect, frames_per_second: 16,
      num_frames: length >= 10 ? 161 : 81, enable_safety_checker: true, enable_output_safety_checker: true,
    }),
  },
  seedance: {
    label: 'Seedance 1.0 Pro Fast',
    endpoint: 'fal-ai/bytedance/seedance/v1/pro/fast/text-to-video',
    lengths: [5, 10],
    price: { 5: 8, 10: 15 }, // ~$1 / 1M video tokens -> ~$0.05 per 5s @480p
    buildInput: ({ prompt, length, aspect }) => ({
      prompt, resolution: '480p', aspect_ratio: aspect, duration: String(length), enable_safety_checker: true,
    }),
  },
  seedance2: {
    label: 'Seedance 2.0 Fast',
    endpoint: 'bytedance/seedance-2.0/fast/text-to-video',
    lengths: [5, 10],
    price: { 5: 60, 10: 115 }, // ~$0.0112 / 1K tokens -> ~$0.53 per 5s @480p
    buildInput: ({ prompt, length, aspect }) => ({
      prompt, resolution: '480p', aspect_ratio: aspect, duration: String(length), generate_audio: false,
    }),
  },
  wan: {
    label: 'Wan 2.5',
    endpoint: 'fal-ai/wan-25-preview/text-to-video',
    lengths: [5, 10],
    price: { 5: 30, 10: 55 }, // $0.05/s @480p
    buildInput: ({ prompt, length, aspect }) => ({
      prompt, resolution: '480p', aspect_ratio: aspect, duration: String(length), enable_safety_checker: true,
    }),
  },
  hailuo: {
    label: 'MiniMax Hailuo 02 Standard (768p)',
    endpoint: 'fal-ai/minimax/hailuo-02/standard/text-to-video',
    lengths: [6, 10], // model only supports 6s / 10s; a 5s request maps to 6s
    price: { 6: 30, 10: 50 }, // $0.045/s
    buildInput: ({ prompt, length }) => ({
      prompt, duration: String(length), prompt_optimizer: true, enable_safety_checker: true,
    }),
  },
  kling: {
    label: 'Kling 2.5 Turbo Pro',
    endpoint: 'fal-ai/kling-video/v2.5-turbo/pro/text-to-video',
    lengths: [5, 10],
    price: { 5: 40, 10: 75 }, // $0.07/s
    buildInput: ({ prompt, length, aspect }) => ({
      prompt, duration: String(length), aspect_ratio: aspect, enable_safety_checker: true,
    }),
  },
};
export const DEFAULT_MODEL = 'fast';

// Real (paid fal) generations are owner-only, max 5 s, and limited to these models.
// fast     = Wan 2.2 5B FastWan, 480p, 81 frames @16fps (~5 s): ~$0.025 per clip (cheapest, default)
// seedance = Seedance 1.0 Pro Fast, 480p, 5 s: ~$0.05 per clip
// kling    = Kling 2.5 Turbo Pro, 5 s: ~$0.35 per clip
export const REAL_MODELS_DEFAULT = ['fast', 'seedance', 'kling'];
export const REAL_MAX_LENGTH = 5;
export const ASPECTS = ['9:16', '16:9', '1:1'];
export const DEFAULT_ASPECT = '9:16';
export const MAX_PROMPT = 1500;

export function resolveLength(model, requested) {
  const m = MODELS[model];
  const want = Number(requested) || 5;
  // pick the closest supported length, prefer the shorter one on ties
  return m.lengths.reduce((best, l) => (Math.abs(l - want) < Math.abs(best - want) ? l : best), m.lengths[0]);
}

export const ALLOWED_ORIGINS = [
  'https://lonekeem.github.io',
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
];
// any http://localhost:<port> / 127.0.0.1:<port> for dev
export const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export const env = {
  supabaseUrl: () => (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  anonKey: () => process.env.SUPABASE_ANON_KEY || '',
  serviceKey: () => process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  serverSecret: () => process.env.API_SERVER_SECRET || '',
  falKey: () => process.env.FAL_KEY || '',
  // 'demo' (default) = sample clips through the same queue/status flow, no fal calls. 'real' = fal.ai.
  // Global/default mode is always demo now; real is per-user (owners only), see realForOwners + lib/owner.js.
  generationMode: () => 'demo',
  // Owner-only real mode. Real fal calls happen ONLY when the signed-in user is an owner AND real is enabled.
  // REAL_FOR_OWNERS=true enables it; REAL_FOR_OWNERS=false always disables it (even if GENERATION_MODE=real);
  // when REAL_FOR_OWNERS is unset, GENERATION_MODE=real is accepted as the legacy switch. Everyone else: demo.
  realForOwners: () => {
    const v = (process.env.REAL_FOR_OWNERS || '').trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return (process.env.GENERATION_MODE || '').toLowerCase() === 'real';
  },
  ownerUserIds: () => list(process.env.OWNER_USER_IDS).map((s) => s.toLowerCase()),
  ownerEmails: () => list(process.env.OWNER_EMAILS).map((s) => s.toLowerCase()),
  ownerDailyRealCap: () => {
    const n = Number(process.env.OWNER_DAILY_REAL_CAP ?? 5);
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 50) : 5;
  },
  realModels: () => {
    const l = list(process.env.OWNER_REAL_MODELS).filter((m) => MODELS[m]);
    return l.length ? l : REAL_MODELS_DEFAULT;
  },
  dailyLimit: () => Number(process.env.DAILY_GENERATION_LIMIT || 10),
  publicBaseUrl: () =>
    (process.env.PUBLIC_BASE_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, ''),
};

function list(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
}
