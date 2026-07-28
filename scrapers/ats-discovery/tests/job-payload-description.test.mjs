import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCreatePayload,
} from '../src/ehestifter/job-payload.mjs';

function candidate(description) {
  return {
    url: 'https://job-boards.greenhouse.io/example/jobs/123',
    applyUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
    foundOn: 'ats-discovery',
    hiringCompanyName: 'Example GmbH',
    postingCompanyName: null,
    title: 'Product Manager',
    remoteType: 'Hybrid',
    description,
    locations: [],
    canonicalIdentity: {
      provider: 'greenhouse',
      providerTenant: 'example',
      externalId: '123',
      identitySource: 'url',
    },
  };
}

test('buildCreatePayload converts plain-text lines into safe readable HTML', () => {
  const payload = buildCreatePayload(candidate(
    'About the role\r\nBuild R&D systems\r\nShip <useful> products'
      + '\r\n\r\n<script>alert("no")</script>',
  ));

  assert.equal(
    payload.description,
    '<p>About the role<br>Build R&amp;D systems<br>'
      + 'Ship &lt;useful&gt; products</p>'
      + '<p>&lt;script&gt;alert("no")&lt;/script&gt;</p>',
  );
});

test('buildCreatePayload collapses blank-line runs into paragraph boundaries', () => {
  const payload = buildCreatePayload(candidate(
    '\n\nFirst paragraph\n\n \nSecond paragraph\n\n',
  ));

  assert.equal(
    payload.description,
    '<p>First paragraph</p><p>Second paragraph</p>',
  );
});

test('buildCreatePayload keeps optional empty descriptions empty', () => {
  const payload = buildCreatePayload(
    candidate(' \r\n\t '),
    {
      requireDescription: false,
    },
  );

  assert.equal(payload.description, '');
});

test('buildCreatePayload still rejects required empty descriptions', () => {
  assert.throws(
    () => buildCreatePayload(candidate(' \n\t ')),
    /Candidate has no description/,
  );
});
