import { env } from './config.js';

// Owner = Supabase user id listed in OWNER_USER_IDS, or a CONFIRMED email listed in OWNER_EMAILS.
// (Unconfirmed emails never count, so nobody can claim owner status by signing up with Keem's address.)
export function isOwner(user) {
  if (!user || !user.id) return false;
  if (env.ownerUserIds().includes(String(user.id).toLowerCase())) return true;
  const email = String(user.email || '').toLowerCase();
  const confirmed = !!(user.email_confirmed_at || user.confirmed_at);
  return !!email && confirmed && env.ownerEmails().includes(email);
}

// What /api/generate will do for this user: 'real' only for owners with real enabled + a fal key.
export function generationModeFor(user) {
  return isOwner(user) && env.realForOwners() && !!env.falKey() ? 'real' : 'demo';
}
