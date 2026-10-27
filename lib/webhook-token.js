import crypto from 'node:crypto';
import { env } from './config.js';

export function webhookToken(clipId) {
  const secret = env.serverSecret() || env.serviceKey();
  return crypto.createHmac('sha256', secret).update(`fal-webhook:${clipId}`).digest('hex').slice(0, 40);
}
export function verifyWebhookToken(clipId, token) {
  if (!token || !(env.serverSecret() || env.serviceKey())) return false;
  const a = Buffer.from(webhookToken(clipId)); const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
