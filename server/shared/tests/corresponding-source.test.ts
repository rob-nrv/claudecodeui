import assert from 'node:assert/strict';
import test from 'node:test';

import { createCorrespondingSourceHandler, readCorrespondingSourceUrl } from '@/shared/corresponding-source.js';

function run(env: NodeJS.ProcessEnv) {
  const out: { status?: number; location?: string; body?: string } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    type() { return res; },
    send(body: string) { out.body = body; },
    redirect(code: number, location: string) { out.status = code; out.location = location; },
  };
  createCorrespondingSourceHandler(env)({} as never, res as never, () => undefined);
  return out;
}

test('the source offer redirects only to the operator https URL and never invents one', () => {
  assert.equal(readCorrespondingSourceUrl({}), null);
  assert.equal(readCorrespondingSourceUrl({ CLOUDCLI_SOURCE_URL: 'http://plain.example/x' }), null);
  assert.equal(readCorrespondingSourceUrl({ CLOUDCLI_SOURCE_URL: 'https://user:pw@host.example/x' }), null);
  assert.equal(readCorrespondingSourceUrl({ CLOUDCLI_SOURCE_URL: 'javascript:alert(1)' }), null);
  assert.equal(readCorrespondingSourceUrl({ CLOUDCLI_SOURCE_URL: 'not a url' }), null);

  assert.deepEqual(run({ CLOUDCLI_SOURCE_URL: 'https://git.example/fork' }), { status: 302, location: 'https://git.example/fork' });
  const unset = run({});
  assert.equal(unset.status, 404, 'unset -> explicit 404, not a redirect to the upstream repository');
  assert.match(unset.body ?? '', /not configured/);
});
