import test from 'node:test';
import assert from 'node:assert/strict';

import bamboohr from '../src/providers/bamboohr.mjs';
import icims from '../src/providers/icims.mjs';
import paylocity from '../src/providers/paylocity.mjs';
import personio from '../src/providers/personio.mjs';
import smartrecruiters from '../src/providers/smartrecruiters.mjs';
import softgarden from '../src/providers/softgarden.mjs';
import successfactors from '../src/providers/successfactors.mjs';

const providers = [
  bamboohr,
  icims,
  paylocity,
  personio,
  smartrecruiters,
  softgarden,
  successfactors,
];

test('Phase 5 providers expose the stable Ehestifter adapter contract', () => {
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['bamboohr', 'icims', 'paylocity', 'personio', 'smartrecruiters', 'softgarden', 'successfactors'],
  );
  for (const provider of providers) {
    assert.equal(typeof provider.detect, 'function');
    assert.equal(typeof provider.tenant, 'function');
    assert.equal(typeof provider.fetch, 'function');
    assert.equal(provider.capabilities.importReady, true);
    assert.equal(typeof provider.capabilities.detail, 'boolean');
    assert.equal(typeof provider.source.repository, 'string');
    assert.equal(provider.source.license, 'MIT');
    assert.match(provider.source.ref, /^[0-9a-f]{40}$/);
  }
});

test('only Personio claims complete list descriptions', () => {
  assert.equal(personio.capabilities.listDescription, true);
  assert.equal(personio.capabilities.detail, false);
  for (const provider of [bamboohr, icims, paylocity, smartrecruiters, softgarden, successfactors]) {
    assert.equal(provider.capabilities.listDescription, false);
    assert.equal(provider.capabilities.detail, true);
  }
});


test('new provider source attribution is pinned to the adapted upstream code', () => {
  for (const provider of [bamboohr, icims]) {
    assert.equal(provider.source.repository, 'santifer/career-ops');
    assert.equal(provider.source.ref, 'b9cd65e8ddba9448c9590c25f45288cf61c1c1c7');
  }
  assert.equal(paylocity.source.repository, 'kalil0321/ats-scrapers');
  assert.equal(paylocity.source.file, 'src/ats_scrapers/scrapers/paylocity.py');
  assert.equal(paylocity.source.ref, '83a694a80679d49376b76e31fccd5676cddf9cd1');
  assert.equal(paylocity.capabilities.explicitIdentityPreflight, true);
});
