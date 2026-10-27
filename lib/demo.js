import { env } from './config.js';

export const DEMO_PREFIX = 'demo:';
const QUEUE_MS = 3000;   // "IN_QUEUE" for 3 s
const RUN_MS = 9000;     // "IN_PROGRESS" until 9 s, then done

export const isDemoClip = (clip) => typeof clip?.fal_request_id === 'string' && clip.fal_request_id.startsWith(DEMO_PREFIX);

// Deterministic sample per clip, matched to the aspect ratio. Files live in /public/demo (served by Vercel).
export function demoVideoUrl(clip) {
  const ar = { '9:16': '9x16', '16:9': '16x9', '1:1': '1x1' }[clip.aspect_ratio] || '9x16';
  const n = parseInt(String(clip.id).replace(/-/g, '').slice(-4), 16) % 3;
  const base = env.publicBaseUrl() || '';
  return `${base}/demo/${ar}-${'abc'[n]}.mp4`;
}

export function demoProgress(clip, now = Date.now()) {
  const started = Number(clip.fal_request_id.slice(DEMO_PREFIX.length)) || new Date(clip.created_at).getTime();
  const age = now - started;
  if (age < QUEUE_MS) return { status: 'IN_QUEUE', queue_position: 0 };
  if (age < RUN_MS) return { status: 'IN_PROGRESS', queue_position: null };
  return { status: 'COMPLETED', queue_position: null };
}

// fal answers 402/403 (and sometimes 4xx with a message) when the account has no balance / payment method.
export function isBillingError(status, detail) {
  if (status === 402) return true;
  const d = String(detail || '').toLowerCase();
  return /balance|exhausted|credit|billing|payment|insufficient|locked|top.?up/.test(d) && (status === 403 || status === 401 || status === 400 || status === 429 || !status);
}
