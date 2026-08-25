import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const providers = ['bamboohr', 'icims', 'paylocity'];

test('issue 3 example config has two disabled canaries for each new provider', async () => {
  const text = await readFile(new URL('../config/portals.example.yml', import.meta.url), 'utf8');
  const canaryText = text.split(/^provider_canaries:\s*$/m)[1] ?? '';
  const blocks = canaryText.split(/^\s{2}- name:\s*/m).slice(1);

  for (const provider of providers) {
    const matches = blocks.filter((block) => (
      new RegExp(`^\\s*provider:\\s*${provider}\\s*$`, 'm').test(block)
    ));
    assert.equal(matches.length, 2, `${provider} must have exactly two example canaries`);
    for (const block of matches) {
      assert.match(block, /^\s*enabled:\s*false\s*$/m);
      assert.match(block, /^\s*minimum_jobs:\s*1\s*$/m);
      assert.match(block, /^\s*minimum_detail_successes:\s*1\s*$/m);
    }
  }
});
