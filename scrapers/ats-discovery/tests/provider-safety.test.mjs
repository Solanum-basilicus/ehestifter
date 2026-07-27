import test from 'node:test';
import assert from 'node:assert/strict';

import { providerSourceMeta } from '../src/providers/_source-meta.mjs';
import {
  assertPublicHttpsUrl,
  sameOrigin,
} from '../src/providers/_url-safety.mjs';

test('provider source metadata is immutable and complete', () => {
  const value = providerSourceMeta({ file: 'providers/test.mjs', ref: 'abc', changes: ['x'] });
  assert.deepEqual(value, {
    repository: 'santifer/career-ops',
    file: 'providers/test.mjs',
    ref: 'abc',
    license: 'MIT',
    changes: ['x'],
  });
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.changes), true);
});

test('public URL safety blocks local and private targets', () => {
  for (const value of [
    'http://jobs.example.com',
    'https://localhost/jobs',
    'https://service.internal/jobs',
    'https://127.0.0.1/jobs',
    'https://10.0.0.2/jobs',
    'https://192.168.1.2/jobs',
    'https://[::1]/jobs',
    'https://[::ffff:127.0.0.1]/jobs',
  ]) {
    assert.throws(() => assertPublicHttpsUrl(value), /must use HTTPS|blocked hostname|private/);
  }
  assert.equal(assertPublicHttpsUrl('https://jobs.example.com/path').hostname, 'jobs.example.com');
});

test('sameOrigin compares parsed origins safely', () => {
  assert.equal(sameOrigin('https://jobs.example.com/a', 'https://jobs.example.com/b'), true);
  assert.equal(sameOrigin('https://jobs.example.com', 'https://other.example.com'), false);
  assert.equal(sameOrigin('bad', 'https://jobs.example.com'), false);
});
