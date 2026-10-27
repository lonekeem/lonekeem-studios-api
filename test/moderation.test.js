import test from 'node:test';
import assert from 'node:assert';
import { keywordCheck } from '../lib/moderation.js';
import { resolveLength, MODELS } from '../lib/config.js';
import { appBase } from '../lib/fal.js';

test('keyword filter', () => {
  assert.equal(keywordCheck('a cat surfing at sunset').allowed, true);
  assert.equal(keywordCheck('NSFW scene').allowed, false);
  assert.equal(keywordCheck('a scope on the rifle').allowed, true);
});
test('lengths', () => {
  assert.equal(resolveLength('hailuo', 5), 6);
  assert.equal(resolveLength('kling', 10), 10);
  for (const [id, m] of Object.entries(MODELS)) for (const l of m.lengths) assert.ok(m.price[l] > 0, id);
});
test('appBase', () => {
  assert.equal(appBase('fal-ai/kling-video/v2.5-turbo/pro/text-to-video'), 'fal-ai/kling-video');
  assert.equal(appBase('bytedance/seedance-2.0/fast/text-to-video'), 'bytedance/seedance-2.0');
});
