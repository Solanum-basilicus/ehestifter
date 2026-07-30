import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enrichCandidateDetails,
} from '../src/details/fetchers.mjs';
import {
  greenhouseHtmlToPlainText,
} from '../src/details/greenhouse-text.mjs';
import {
  buildCreatePayload,
} from '../src/ehestifter/job-payload.mjs';

const ENCODED_GREENHOUSE_DESCRIPTION = [
  '&lt;p&gt;&lt;strong&gt;SUMMARY:&lt;/strong&gt;&lt;/p&gt;',
  '&lt;p&gt;Build R&amp;amp;D systems.&amp;nbsp; Safely.&lt;/p&gt;',
  '&lt;p&gt;&lt;strong&gt;PRIMARY DUTIES:&lt;/strong&gt;&lt;/p&gt;',
  '&lt;ul&gt;',
  '&lt;li&gt;First item&lt;/li&gt;',
  '&lt;li&gt;Second item&lt;/li&gt;',
  '&lt;/ul&gt;',
  '&lt;p&gt;Pay $26&amp;mdash;$31.25 USD.&lt;/p&gt;',
  '&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;',
].join('');

function candidate() {
  return {
    url: 'https://job-boards.greenhouse.io/example/jobs/123',
    applyUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    foundOn: 'ats-discovery',
    hiringCompanyName: 'Example GmbH',
    postingCompanyName: null,
    title: 'Product Delivery Coordinator',
    description: '',
    descriptionStatus: 'missing',
    remoteType: 'Remote',
    locations: [],
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '123',
      identitySource: 'url',
    },
    preflight: {
      status: 'ok',
      exists: false,
    },
  };
}

test('Greenhouse encoded editor HTML becomes structured plain text', () => {
  assert.equal(
    greenhouseHtmlToPlainText(ENCODED_GREENHOUSE_DESCRIPTION),
    'SUMMARY:\n\nBuild R&D systems. Safely.\n\n'
      + 'PRIMARY DUTIES:\n\n- First item\n\n- Second item\n\n'
      + 'Pay $26—$31.25 USD.',
  );
});

test('Greenhouse conversion preserves literal escaped markup as text', () => {
  assert.equal(
    greenhouseHtmlToPlainText(
      '&lt;p&gt;Use &amp;lt;strong&amp;gt; literally.&lt;/p&gt;',
    ),
    'Use <strong> literally.',
  );

  assert.equal(
    greenhouseHtmlToPlainText(
      '<p>Use &lt;strong&gt; literally &amp; safely.</p>',
    ),
    'Use <strong> literally & safely.',
  );
});

test('Greenhouse detail enrichment produces safe Jobs HTML end to end', async () => {
  const [enriched] = await enrichCandidateDetails(
    [candidate()],
    {
      concurrency: 1,
      maxFetches: 1,
      timeoutMs: 1000,
      fetchImpl: async () => new Response(
        JSON.stringify({
          absolute_url: 'https://job-boards.greenhouse.io/example/jobs/123',
          content: ENCODED_GREENHOUSE_DESCRIPTION,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    },
  );

  assert.equal(enriched.detail.status, 'ok');
  assert.doesNotMatch(enriched.description, /&lt;\/?(?:p|li|span|div)\b/i);
  assert.doesNotMatch(enriched.description, /<\/?(?:p|li|span|div)\b/i);
  assert.doesNotMatch(enriched.description, /alert\(/i);

  const payload = buildCreatePayload(enriched);
  assert.equal(
    payload.description,
    '<p>SUMMARY:</p>'
      + '<p>Build R&amp;D systems. Safely.</p>'
      + '<p>PRIMARY DUTIES:</p>'
      + '<p>- First item</p>'
      + '<p>- Second item</p>'
      + '<p>Pay $26—$31.25 USD.</p>',
  );
});
