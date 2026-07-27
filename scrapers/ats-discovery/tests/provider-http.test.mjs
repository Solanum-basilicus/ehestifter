import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpSession } from '../src/providers/_http.mjs';

test('HTTP session persists response cookies only to the same origin', async () => {
  const requests = [];
  const session = createHttpSession({
    fetchImpl: async (url, options) => {
      requests.push({
        url: String(url),
        cookie: options.headers.get('cookie'),
      });
      if (requests.length === 1) {
        return new Response('<meta name="csrf-token" content="token">', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'set-cookie': 'route=node-a; Path=/, JSESSIONID=session-1; Path=/; HttpOnly',
          },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await session.fetchText('https://jobs.example.com/');
  assert.deepEqual(
    await session.fetchJson('https://jobs.example.com/services/recruiting/v1/jobs'),
    { ok: true },
  );
  await session.fetchJson('https://other.example.com/jobs');

  assert.equal(requests[0].cookie, null);
  assert.match(requests[1].cookie, /route=node-a/);
  assert.match(requests[1].cookie, /JSESSIONID=session-1/);
  assert.equal(requests[2].cookie, null);
});

test('HTTP session replaces refreshed cookies without exposing attributes', async () => {
  const cookies = [];
  let call = 0;
  const session = createHttpSession({
    fetchImpl: async (_url, options) => {
      cookies.push(options.headers.get('cookie'));
      call += 1;
      return new Response(call === 3 ? '{"ok":true}' : 'ok', {
        status: 200,
        headers: call === 1
          ? { 'set-cookie': 'JSESSIONID=old; Path=/; HttpOnly' }
          : call === 2
            ? { 'set-cookie': 'JSESSIONID=new; Path=/; HttpOnly' }
            : { 'content-type': 'application/json' },
      });
    },
  });

  await session.fetchText('https://jobs.example.com/');
  await session.fetchText('https://jobs.example.com/refresh');
  await session.fetchJson('https://jobs.example.com/api');

  assert.equal(cookies[0], null);
  assert.equal(cookies[1], 'JSESSIONID=old');
  assert.equal(cookies[2], 'JSESSIONID=new');
  assert.doesNotMatch(cookies[2], /Path|HttpOnly/);
});
