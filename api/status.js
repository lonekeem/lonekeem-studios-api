import { applyCors, send, methodGuard, bearer } from '../lib/http.js';
import { getUser, getOwnClip, serverRpc, copyVideoToStorage } from '../lib/supabase.js';
import { env } from '../lib/config.js';
import * as fal from '../lib/fal.js';
import { clipView } from '../lib/clip-view.js';
import { isDemoClip, demoProgress, demoVideoUrl, isBillingError } from '../lib/demo.js';

const STALE_MS = 60 * 60 * 1000; // give up (and refund) after 60 min

async function finalizeDone({ jwt, user, clip, videoUrl }) {
  let url = videoUrl, path = null;
  try {
    const copy = await copyVideoToStorage({ jwt, userId: user.id, clipId: clip.id, videoUrl });
    if (copy) { url = copy.publicUrl; path = copy.path; }
  } catch (e) { console.warn('storage copy failed; keeping fal url', e.message); }
  await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'done', p_video_url: url, p_storage_path: path });
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (!methodGuard(req, res, ['GET'])) return;
  const jwt = bearer(req);
  const user = await getUser(jwt);
  if (!user) return send(res, 401, { error: 'unauthorized' });

  const id = String(req.query?.id || new URL(req.url, 'http://x').searchParams.get('id') || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return send(res, 400, { error: 'id_required' });

  let clip = await getOwnClip(jwt, id);
  if (!clip || clip.owner_id !== user.id) return send(res, 404, { error: 'not_found' });

  // Demo clips: simulated queue -> running -> done with a built-in sample video (no fal, no storage copy)
  if (isDemoClip(clip) && clip.status !== 'done' && clip.status !== 'failed') {
    const p = demoProgress(clip);
    if (p.status === 'COMPLETED') {
      await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'done', p_video_url: demoVideoUrl(clip), p_storage_path: null });
      clip = await getOwnClip(jwt, id);
      return send(res, 200, { clip: clipView(clip), mode: 'demo' });
    }
    const st = p.status === 'IN_PROGRESS' ? 'running' : 'queued';
    if (st !== clip.status) { await serverRpc('set_clip_request', { p_clip: clip.id, p_request_id: null, p_status: st }).catch(() => {}); clip.status = st; }
    return send(res, 200, { clip: clipView(clip), mode: 'demo', provider: p });
  }

  // Finished by the webhook with a fal URL: opportunistically move it into Supabase storage
  if (clip.status === 'done' && !clip.storage_path && clip.video_url && !isDemoClip(clip)) {
    try {
      const copy = await copyVideoToStorage({ jwt, userId: user.id, clipId: clip.id, videoUrl: clip.video_url });
      if (copy) {
        await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'done', p_video_url: copy.publicUrl, p_storage_path: copy.path });
        clip = await getOwnClip(jwt, id);
      }
    } catch { /* keep fal url */ }
  }
  if (clip.status === 'done' || clip.status === 'failed') return send(res, 200, { clip: clipView(clip), mode: isDemoClip(clip) ? 'demo' : 'real' });

  if (!clip.fal_request_id || !env.falKey()) {
    if (Date.now() - new Date(clip.created_at).getTime() > STALE_MS) {
      await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'failed', p_error: 'timeout' });
      clip = await getOwnClip(jwt, id);
    }
    return send(res, 200, { clip: clipView(clip) });
  }

  let st;
  try { st = await fal.status(clip.fal_endpoint, clip.fal_request_id); }
  catch (e) {
    console.error('fal status', e.status);
    return send(res, 200, { clip: clipView(clip), provider: { status: 'UNKNOWN' } });
  }

  if (st.status === 'COMPLETED') {
    const r = await fal.result(clip.fal_endpoint, clip.fal_request_id);
    const videoUrl = r.ok ? fal.videoUrlFrom(r.data) : null;
    if (videoUrl) await finalizeDone({ jwt, user, clip, videoUrl });
    else {
      const detail = r.data && r.data.detail ? (typeof r.data.detail === 'string' ? r.data.detail : JSON.stringify(r.data.detail)) : `http_${r.status}`;
      const err = isBillingError(r.status, detail) ? 'real_generation_not_enabled' : String(detail).slice(0, 300);
      await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'failed', p_error: err });
    }
    clip = await getOwnClip(jwt, id);
    return send(res, 200, { clip: clipView(clip) });
  }

  const newStatus = st.status === 'IN_PROGRESS' ? 'running' : 'queued';
  if (newStatus !== clip.status) {
    await serverRpc('set_clip_request', { p_clip: clip.id, p_request_id: null, p_status: newStatus }).catch(() => {});
    clip.status = newStatus;
  }
  if (Date.now() - new Date(clip.created_at).getTime() > STALE_MS) {
    await serverRpc('finish_clip', { p_clip: clip.id, p_status: 'failed', p_error: 'timeout' });
    clip = await getOwnClip(jwt, id);
  }
  return send(res, 200, { clip: clipView(clip), provider: { status: st.status, queue_position: st.queue_position ?? null } });
}
