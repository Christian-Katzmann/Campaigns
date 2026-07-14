import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { buildFeatureRequestUrl } from '../public/lib/feature-request.mjs';

test('feature request URL targets the repo template with encoded local app details', () => {
  assert.equal(
    buildFeatureRequestUrl({ version: '0.2.0+build 7', platform: 'darwin / arm64' }),
    'https://github.com/Christian-Katzmann/Campaigns/issues/new?template=feature_request.md&body=Version%3A+0.2.0%2Bbuild+7%0APlatform%3A+darwin+%2F+arm64',
  );
});

test('settings exposes a safe normal link without a speculative GitHub request', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /<a id="feature-request-link" class="settings-feature-link" target="_blank" rel="noopener noreferrer" hidden>Suggest a feature ↗<\/a>/,
  );
});
