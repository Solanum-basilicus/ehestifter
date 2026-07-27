import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJobPostingJsonLd } from '../src/details/jobposting-jsonld.mjs';

function page(value) {
  return `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
}

test('JobPosting JSON-LD parses description, same-origin URL, remote, and address', () => {
  const parsed = parseJobPostingJsonLd(page({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    description: '<p>Build things.</p><ul><li>Lead</li></ul>',
    url: '/apply/42',
    jobLocationType: 'TELECOMMUTE',
    jobLocation: {
      '@type': 'Place',
      address: {
        addressCountry: { name: 'Germany' },
        addressLocality: 'Berlin',
        addressRegion: 'Berlin',
      },
    },
  }), 'https://jobs.example.com/job/42');
  assert.equal(parsed.description, 'Build things.\n\n- Lead');
  assert.equal(parsed.applyUrl, 'https://jobs.example.com/apply/42');
  assert.equal(parsed.remoteType, 'Remote');
  assert.deepEqual(parsed.locations, [{
    countryName: 'Germany',
    countryCode: null,
    cityName: 'Berlin',
    region: 'Berlin',
  }]);
});

test('JobPosting JSON-LD traverses arrays and @graph and deduplicates locations', () => {
  const parsed = parseJobPostingJsonLd(page({
    '@graph': [
      { '@type': 'Organization', name: 'Acme' },
      {
        '@type': ['Thing', 'JobPosting'],
        description: 'Role',
        jobLocation: [
          { address: { addressCountry: 'Germany', addressLocality: 'Munich' } },
          { address: { addressCountry: 'Germany', addressLocality: 'Munich' } },
        ],
        applicantLocationRequirements: {
          '@type': 'Country',
          name: 'Austria',
        },
      },
    ],
  }), 'https://jobs.example.com/job/1');
  assert.equal(parsed.locations.length, 2);
  assert.equal(parsed.locations[1].countryName, 'Austria');
});

test('JobPosting JSON-LD rejects external apply URLs', () => {
  const parsed = parseJobPostingJsonLd(page({
    '@type': 'JobPosting',
    description: 'Role',
    url: 'https://evil.example/apply',
  }), 'https://jobs.example.com/job/1');
  assert.equal(parsed.applyUrl, null);
});

test('JobPosting JSON-LD ignores malformed scripts and returns null without a job', () => {
  const html = '<script type="application/ld+json">bad</script>'
    + '<script type="application/ld+json">{"@type":"Organization"}</script>';
  assert.equal(parseJobPostingJsonLd(html, 'https://jobs.example.com'), null);
});
