import { send, methodGuard, readJson } from '../lib/http.js';
import { serverRpc } from '../lib/supabase.js';
import { verifyWebhookToken } from '../lib/webhook-token.js';
import { videoUrlFrom } from '../lib/fal.js';

// fal calls this when a queued request finishes: POST /api/fal-webhook?clip=<id>&t=<hmac>
// Body: { request_id, status: "OK" | "ERROR", payload, error }
export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const clipId = String(q.clip || '');
  if (!/^[0-9a-f-]{36}$/i.test(clipId) || !verifyWebhookToken(clipId, q.t)) return send(res, 401, { error: 'unauthorized' });

  const body = await readJson(req);
  if (!body) return send(res, 400, { error: 'invalid_json' });

  const clip = await serverRpc('get_clip_server', { p_clip: clipId }).catch(() => null);
  if (!clip || !clip.id) return send(res, 404, { error: 'not_found' });
  if (clip.fal_request_id && body.request_id && clip.fal_request_id !== body.request_id) return send(res, 409, { error: 'request_mismatch' });

  const url = body.status === 'OK' ? videoUrlFrom(body.payload) : null;
  if (url) {
    // Keep the fal URL here; GET /api/status copies it into Supabase storage on the next poll.
    await serverRpc('finish_clip', { p_clip: clipId, p_status: 'done', p_video_url: url });
  } else {
    const err = body.error || (body.payload && body.payload.detail) || 'provider_error';
    await serverRpc('finish_clip', { p_clip: clipId, p_status: 'failed', p_error: String(typeof err === 'string' ? err : JSON.stringify(err)).slice(0, 300) });
  }
  return send(res, 200, { ok: true });
}
