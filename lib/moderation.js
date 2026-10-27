import { env } from './config.js';

// Simple first-line filter. Keep words lowercase; matched on word boundaries.
const BLOCKLIST = [
  // sexual content involving minors / CSAM - always blocked
  'child porn', 'cp', 'loli', 'lolicon', 'shota', 'underage sex', 'minor nude', 'preteen',
  // explicit sexual content
  'porn', 'pornographic', 'nude', 'nudity', 'naked', 'nsfw', 'sex scene', 'explicit sex', 'hentai', 'genitals',
  // extreme violence / gore
  'beheading', 'decapitation', 'gore', 'dismember', 'torture porn',
  // self-harm
  'suicide', 'self harm', 'self-harm', 'cutting myself',
  // terrorism / weapons
  'terrorist attack', 'mass shooting', 'school shooting', 'bomb making', 'build a bomb',
  // hate
  'nazi propaganda', 'ethnic cleansing', 'genocide',
  // non-consensual / real-person deepfakes
  'deepfake', 'revenge porn', 'non-consensual',
];
const PATTERNS = BLOCKLIST.map((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+')}($|[^a-z0-9])`, 'i'));

export function keywordCheck(text) {
  const t = String(text || '').toLowerCase();
  const hits = BLOCKLIST.filter((_, i) => PATTERNS[i].test(t));
  return { allowed: hits.length === 0, hits };
}

// Hook for a real moderation model later. If MODERATION_WEBHOOK_URL is set, POSTs {text}
// and expects {allowed: boolean, reason?: string}. Fails closed on errors only if MODERATION_FAIL_CLOSED=1.
async function modelCheck(text) {
  const url = process.env.MODERATION_WEBHOOK_URL;
  if (!url) return { allowed: true, skipped: true };
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    const d = await r.json();
    return { allowed: d.allowed !== false, reason: d.reason };
  } catch (e) {
    return { allowed: process.env.MODERATION_FAIL_CLOSED !== '1', error: 'moderation_unavailable' };
  }
}

export async function moderate(text) {
  const k = keywordCheck(text);
  if (!k.allowed) return { allowed: false, reason: 'blocked_terms', terms: k.hits };
  const m = await modelCheck(text);
  if (!m.allowed) return { allowed: false, reason: m.reason || 'moderation_model' };
  return { allowed: true };
}
void env;
