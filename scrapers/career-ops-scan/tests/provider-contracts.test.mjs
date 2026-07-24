import test from 'node:test';
import assert from 'node:assert/strict';

import personio from '../src/providers/personio.mjs';
import smartrecruiters from '../src/providers/smartrecruiters.mjs';
import softgarden from '../src/providers/softgarden.mjs';
import successfactors from '../src/providers/successfactors.mjs';

const providers = [personio, smartrecruiters, softgarden, successfactors];

test('Phase 5 providers expose the stable Ehestifter adapter contract', () => {
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['personio', 'smartrecruiters', 'softgarden', 'successfactors'],
  );
  for (const provider of providers) {
    assert.equal(typeof provider.detect, 'function');
    assert.equal(typeof provider.tenant, 'function');
    assert.equal(typeof provider.fetch, 'function');
    assert.equal(provider.capabilities.importReady, true);
    assert.equal(typeof provider.capabilities.detail, 'boolean');
    assert.equal(provider.source.repository, 'santifer/career-ops');
    assert.equal(provider.source.license, 'MIT');
    assert.match(provider.source.ref, /^[0-9a-f]{40}$/);
  }
});

test('only Personio claims complete list descriptions', () => {
  assert.equal(personio.capabilities.listDescription, true);
  assert.equal(personio.capabilities.detail, false);
  for (const provider of [smartrecruiters, softgarden, successfactors]) {
    assert.equal(provider.capabilities.listDescription, false);
    assert.equal(provider.capabilities.detail, true);
  }
});
