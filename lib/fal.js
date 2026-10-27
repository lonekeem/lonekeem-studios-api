import { env } from './config.js';

const QUEUE = 'https://queue.fal.run';

// Queue status/result URLs use only "owner/app" (first two path segments) of the endpoint id.
export function appBase(endpoint) {
  return endpoint.split('/').slice(0, 2).join('/');
}

function headers() {
  return { Authorization: `Key ${env.falKey()}`, 'Content-Type': 'application/json' };
}

export async function submit(endpoint, input, webhookUrl) {
  const url = `${QUEUE}/${endpoint}${webhookUrl ? `?fal_webhook=${encodeURIComponent(webhookUrl)}` : ''}`;
  const r = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.request_id) {
    const e = new Error(`fal submit failed (${r.status})`);
    e.status = r.status; e.detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data).slice(0, 300);
    throw e;
  }
  return data; // { request_id, status_url, response_url, ... }
}

export async function status(endpoint, requestId) {
  const r = await fetch(`${QUEUE}/${appBase(endpoint)}/requests/${requestId}/status`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`fal status failed (${r.status})`); e.status = r.status; e.detail = data; throw e; }
  return data; // { status: IN_QUEUE | IN_PROGRESS | COMPLETED, queue_position?, error? }
}

export async function result(endpoint, requestId) {
  const r = await fetch(`${QUEUE}/${appBase(endpoint)}/requests/${requestId}`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export function videoUrlFrom(payload) {
  if (!payload) return null;
  if (payload.video && payload.video.url) return payload.video.url;
  if (Array.isArray(payload.videos) && payload.videos[0]?.url) return payload.videos[0].url;
  if (payload.url) return payload.url;
  return null;
}
