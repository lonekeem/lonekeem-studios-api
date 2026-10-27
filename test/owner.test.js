import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwner, generationModeFor } from '../lib/owner.js';
import { env } from '../lib/config.js';

const reset = () => { for (const k of ['OWNER_USER_IDS', 'OWNER_EMAILS', 'REAL_FOR_OWNERS', 'GENERATION_MODE', 'FAL_KEY', 'OWNER_DAILY_REAL_CAP', 'OWNER_REAL_MODELS']) delete process.env[k]; };
const keem = { id: '11111111-2222-3333-4444-555555555555', email: 'Keem@Example.com', email_confirmed_at: '2026-01-01' };
const other = { id: '99999999-2222-3333-4444-555555555555', email: 'x@y.z', email_confirmed_at: '2026-01-01' };

test('owners by id or confirmed email only', () => {
  reset();
  assert.equal(isOwner(keem), false);
  process.env.OWNER_USER_IDS = ` ${keem.id.toUpperCase()} ,abc`;
  assert.equal(isOwner(keem), true);
  assert.equal(isOwner(other), false);
  reset();
  process.env.OWNER_EMAILS = 'keem@example.com';
  assert.equal(isOwner(keem), true);
  assert.equal(isOwner({ ...keem, email_confirmed_at: null }), false);
});

test('real only for owners with REAL_FOR_OWNERS and a fal key; everyone else demo', () => {
  reset();
  process.env.OWNER_USER_IDS = keem.id; process.env.FAL_KEY = 'x';
  assert.equal(generationModeFor(keem), 'demo');
  process.env.REAL_FOR_OWNERS = 'true';
  assert.equal(generationModeFor(keem), 'real');
  assert.equal(generationModeFor(other), 'demo');
  process.env.GENERATION_MODE = 'real'; process.env.REAL_FOR_OWNERS = 'false';
  assert.equal(generationModeFor(keem), 'demo');
  assert.equal(generationModeFor(other), 'demo');
  delete process.env.FAL_KEY; process.env.REAL_FOR_OWNERS = 'true';
  assert.equal(generationModeFor(keem), 'demo');
  assert.equal(env.generationMode(), 'demo');
});

test('cap and model allowlist defaults', () => {
  reset();
  assert.equal(env.ownerDailyRealCap(), 5);
  process.env.OWNER_DAILY_REAL_CAP = '2';
  assert.equal(env.ownerDailyRealCap(), 2);
  assert.deepEqual(env.realModels(), ['fast', 'seedance', 'kling']);
  process.env.OWNER_REAL_MODELS = 'kling,bogus';
  assert.deepEqual(env.realModels(), ['kling']);
  reset();
});
