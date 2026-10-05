import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRunJournal } from '../src/artifacts/run-journal.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-run-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('run journal flushes bounded NDJSON records during the run', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const journal = await createRunJournal({
    dataPath,
    runId: 'run-1',
    startedAt: new Date('2026-10-05T00:00:00Z'),
    recordsPerFlush: 2,
    charactersPerFlush: 1024,
  });

  journal.record('rejected', { reason: 'first' });
  journal.record('rejected', { reason: 'second' });
  await journal.flush();

  const partialPath = path.join(dataPath, 'runs', 'run-1.partial');
  const lines = (await readFile(path.join(partialPath, 'rejected.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(lines, [{ reason: 'first' }, { reason: 'second' }]);

  await journal.checkpoint('provider_scan', { targetsAttempted: 2 });
  const checkpoint = JSON.parse(await readFile(path.join(partialPath, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.stage, 'provider_scan');
  assert.equal(checkpoint.targetsAttempted, 2);
});

test('run journal records can be replayed as an async iterable and missing streams are empty', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const journal = await createRunJournal({ dataPath, runId: 'run-2' });
  journal.recordMany('rejected', [{ id: 1 }, { id: 2 }, { id: 3 }]);

  const replayed = [];
  for await (const item of journal.records('rejected')) replayed.push(item);
  assert.deepEqual(replayed, [{ id: 1 }, { id: 2 }, { id: 3 }]);

  const missing = [];
  for await (const item of journal.records('not-created')) missing.push(item);
  assert.deepEqual(missing, []);
});

test('successful cleanup removes the partial journal directory', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const journal = await createRunJournal({ dataPath, runId: 'run-3' });
  journal.record('provider-results', { status: 'ok' });
  await journal.remove();

  assert.deepEqual(await readdir(path.join(dataPath, 'runs')), []);
});

test('run journal reports deferred append failures at the next flush', async (t) => {
  const dataPath = await temporaryDirectory(t);
  const journal = await createRunJournal({
    dataPath,
    runId: 'run-write-failure',
    recordsPerFlush: 1,
    charactersPerFlush: 1024,
  });
  await rm(journal.path, { recursive: true, force: true });
  journal.record('rejected', { reason: 'cannot-write' });
  await assert.rejects(journal.flush(), /ENOENT/u);
});
