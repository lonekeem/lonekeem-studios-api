import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProgress, demoVideoUrl, isBillingError, isDemoClip } from '../lib/demo.js';
import { env } from '../lib/config.js';

test('demo progress: queued -> running -> completed', () => {
  const t0 = 1_000_000;
  const clip = { fal_request_id: `demo:${t0}` };
  assert.equal(demoProgress(clip, t0 + 1000).status, 'IN_QUEUE');
  assert.equal(demoProgress(clip, t0 + 5000).status, 'IN_PROGRESS');
  assert.equal(demoProgress(clip, t0 + 10000).status, 'COMPLETED');
  assert.ok(isDemoClip(clip));
  assert.ok(!isDemoClip({ fal_request_id: 'abc' }));
});

test('demo video matches aspect ratio', () => {
  assert.match(demoVideoUrl({ id: '00000000-0000-0000-0000-000000000001', aspect_ratio: '16:9' }), /\/demo\/16x9-[abc]\.mp4$/);
  assert.match(demoVideoUrl({ id: '00000000-0000-0000-0000-000000000002', aspect_ratio: '1:1' }), /\/demo\/1x1-[abc]\.mp4$/);
});

test('billing errors detected', () => {
  assert.ok(isBillingError(402, ''));
  assert.ok(isBillingError(403, 'User is locked. Reason: Exhausted balance.'));
  assert.ok(!isBillingError(422, 'prompt too long'));
  assert.ok(!isBillingError(500, ''));
});

test('global generation mode is always demo (real is per-owner only)', () => {
  delete process.env.GENERATION_MODE;
  assert.equal(env.generationMode(), 'demo');
  process.env.GENERATION_MODE = 'REAL';
  assert.equal(env.generationMode(), 'demo');
  delete process.env.GENERATION_MODE;
});
