export function clipView(c) {
  if (!c) return null;
  return {
    id: c.id, status: c.status, model: c.model, prompt: c.prompt, length: c.length_s, quality: c.quality,
    aspect_ratio: c.aspect_ratio, cost: c.cost, refunded: !!c.refunded, video_url: c.video_url || null,
    storage_path: c.storage_path || null, error: c.error || null, character_id: c.character_id || null,
    demo: typeof c.fal_request_id === 'string' && c.fal_request_id.startsWith('demo:'),
    created_at: c.created_at, updated_at: c.updated_at,
  };
}
