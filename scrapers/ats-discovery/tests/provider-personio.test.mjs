import test from 'node:test';
import assert from 'node:assert/strict';

import personio, {
  parsePersonioXml,
} from '../src/providers/personio.mjs';

const XML = `<?xml version="1.0"?>
<workzag-jobs>
  <position>
    <id>101</id>
    <name><![CDATA[Senior Product Manager &amp; AI]]></name>
    <createdAt>2026-07-01T12:00:00+02:00</createdAt>
    <office>Berlin</office>
    <office><![CDATA[Remote Germany]]></office>
    <jobDescriptions>
      <jobDescription>
        <name>About the role</name>
        <value><![CDATA[<p>Build useful products.</p><ul><li>Lead discovery</li></ul>]]></value>
      </jobDescription>
    </jobDescriptions>
  </position>
  <position><id>bad</id><name>Ignored</name></position>
</workzag-jobs>`;

test('Personio detects only supported HTTPS jobs hosts and derives tenant', () => {
  const entry = { careers_url: 'https://acme.jobs.personio.de/jobs' };
  assert.equal(personio.detect(entry).url, 'https://acme.jobs.personio.de/xml');
  assert.equal(personio.tenant(entry), 'acme');
  assert.equal(personio.detect({ careers_url: 'http://acme.jobs.personio.de' }), null);
  assert.equal(personio.detect({ careers_url: 'https://personio.example.com' }), null);
});

test('Personio parser maps ids, offices, dates, and list descriptions', () => {
  const jobs = parsePersonioXml(XML, 'Acme', 'acme.jobs.personio.de');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, '101');
  assert.equal(jobs[0].title, 'Senior Product Manager & AI');
  assert.equal(jobs[0].location, 'Berlin / Remote Germany');
  assert.equal(jobs[0].url, 'https://acme.jobs.personio.de/job/101');
  assert.match(jobs[0].description, /About the role/);
  assert.match(jobs[0].description, /- Lead discovery/);
  assert.equal(jobs[0].postedAt, Date.parse('2026-07-01T12:00:00+02:00'));
});

test('Personio balanced XML extraction ignores position-like text inside CDATA', () => {
  const xml = `<workzag-jobs><position><id>7</id><name>PM</name>
    <jobDescriptions><jobDescription><value><![CDATA[
      literal </position> text <p>still description</p>
    ]]></value></jobDescription></jobDescriptions>
  </position></workzag-jobs>`;
  const [job] = parsePersonioXml(xml, 'Acme', 'acme.jobs.personio.com');
  assert.equal(job.id, '7');
  assert.match(job.description, /literal text still description/);
});

test('Personio fetch uses one XML request and returns parsed jobs', async () => {
  const calls = [];
  const jobs = await personio.fetch(
    { name: 'Acme', careers_url: 'https://acme.jobs.personio.com' },
    {
      async fetchText(url, options) {
        calls.push({ url: String(url), options });
        return XML;
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://acme.jobs.personio.com/xml');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(jobs.length, 1);
});

test('Personio parser deduplicates repeated position ids', () => {
  const jobs = parsePersonioXml(
    '<jobs><position><id>1</id><name>PM</name></position>'
      + '<position><id>1</id><name>Duplicate</name></position></jobs>',
    'Acme',
    'acme.jobs.personio.de',
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'PM');
});
