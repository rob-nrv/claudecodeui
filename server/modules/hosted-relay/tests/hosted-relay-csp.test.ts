import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildRelayContentSecurityPolicy, hashInlineScripts } from '@/modules/hosted-relay/hosted-relay-csp.js';

const HTML = `<html><head></head><body>
<script type="module" crossorigin src="/assets/index.js"></script>
<script>navigator.serviceWorker.register('/sw.js')</script>
</body></html>`;

test('the CSP allows the bundle and exactly the inline script that ships, and nothing broader', () => {
  const expected = `'sha256-${createHash('sha256').update("navigator.serviceWorker.register('/sw.js')").digest('base64')}'`;
  assert.deepEqual(hashInlineScripts(HTML), [expected]);

  const policy = buildRelayContentSecurityPolicy('https://relay.example.com', HTML);
  assert.ok(policy.includes(`script-src 'self' ${expected};`));
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-(inline|eval)/);
  assert.match(policy, /connect-src 'self' wss:\/\/relay\.example\.com;/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /default-src 'self'/);
});

test('changing the inline script changes the hash, so a tampered page is not allowed', () => {
  const tampered = HTML.replace('/sw.js', '/evil.js');
  assert.notDeepEqual(hashInlineScripts(tampered), hashInlineScripts(HTML));
});
