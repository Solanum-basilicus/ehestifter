import test from 'node:test';
import assert from 'node:assert/strict';

import lever, {
  composeLeverDescription,
} from '../src/providers/lever.mjs';

const COMPLETE_POSTING = {
  id: '7c97a721-9d46-4568-a803-a11a7f669a5b',
  text: 'Implementation Manager',
  hostedUrl: 'https://jobs.lever.co/360learning/7c97a721-9d46-4568-a803-a11a7f669a5b',
  createdAt: 1_720_000_000_000,
  categories: { location: 'Paris' },
  descriptionPlain: 'Intro & role.',
  openingPlain: 'Intro & role.',
  descriptionBodyPlain: 'This duplicate fallback must not appear.',
  lists: [
    {
      text: 'Within 1 month',
      content: '<ul><li>Own kickoff</li><li>Meet Sales &amp; Success</li></ul>',
    },
    {
      text: '<strong>Skill Set</strong>',
      content: '<div><ul><li>Project management</li></ul></div>',
    },
    null,
    { text: '   ', content: '' },
  ],
  additionalPlain: 'Closing company information.',
  additional: '<p>This duplicate fallback must not appear.</p>',
};

test('Lever detects global and EU hosted boards', () => {
  assert.deepEqual(
    lever.detect({ careers_url: 'https://jobs.lever.co/acme' }),
    { url: 'https://api.lever.co/v0/postings/acme' },
  );
  assert.deepEqual(
    lever.detect({ careers_url: 'https://jobs.eu.lever.co/acme/jobs' }),
    { url: 'https://api.eu.lever.co/v0/postings/acme' },
  );
  assert.equal(lever.detect({ careers_url: 'https://lever.example/acme' }), null);
});

test('Lever composes opening/body, structured lists, and closing content in order', () => {
  const description = composeLeverDescription(COMPLETE_POSTING);

  assert.equal(description, [
    'Intro & role.',
    'Within 1 month\n\n- Own kickoff\n- Meet Sales & Success',
    'Skill Set\n\n- Project management',
    'Closing company information.',
  ].join('\n\n'));
  assert.equal(description.includes('duplicate fallback'), false);
  assert.equal(description.includes('<'), false);
});

test('Lever falls back to split plaintext fields and HTML closing content', () => {
  const description = composeLeverDescription({
    openingPlain: 'Opening.',
    descriptionBodyPlain: 'Body.',
    lists: 'not-an-array',
    additional: '<p>Closing &amp; legal.</p>',
  });

  assert.equal(description, 'Opening.\n\nBody.\n\nClosing & legal.');
});

test('Lever falls back to HTML opening/body when plaintext fields are absent', () => {
  const description = composeLeverDescription({
    opening: '<p>Opening <strong>HTML</strong>.</p>',
    descriptionBody: '<ul><li>First responsibility</li></ul>',
  });

  assert.equal(description, 'Opening HTML.\n\n- First responsibility');
});

test('Lever fetch performs one list request and returns the complete description', async () => {
  const calls = [];
  const jobs = await lever.fetch(
    {
      name: '360Learning',
      careers_url: 'https://jobs.lever.co/360learning',
    },
    {
      async fetchJson(url, options) {
        calls.push({ url: String(url), options });
        return [COMPLETE_POSTING];
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.lever.co/v0/postings/360learning');
  assert.deepEqual(calls[0].options, { redirect: 'error' });
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].description, /Within 1 month/);
  assert.match(jobs[0].description, /Project management/);
  assert.match(jobs[0].description, /Closing company information/);
});

test('Lever returns an empty description for malformed posting content', () => {
  assert.equal(composeLeverDescription(null), '');
  assert.equal(composeLeverDescription([]), '');
  assert.equal(composeLeverDescription({ lists: [null, 4, 'bad'] }), '');
});
