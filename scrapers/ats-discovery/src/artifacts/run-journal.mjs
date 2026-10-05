import { createReadStream } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { writeJsonAtomic } from '../io/atomic-json.mjs';

const DEFAULT_RECORDS_PER_FLUSH = 100;
const DEFAULT_CHARACTERS_PER_FLUSH = 1_048_576;

function safeName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/u.test(value)) {
    throw new Error('journal stream name must contain lowercase letters, digits, and hyphens');
  }
  return value;
}

export async function createRunJournal({
  dataPath,
  runId,
  startedAt = new Date(),
  recordsPerFlush = DEFAULT_RECORDS_PER_FLUSH,
  charactersPerFlush = DEFAULT_CHARACTERS_PER_FLUSH,
}) {
  if (!Number.isInteger(recordsPerFlush) || recordsPerFlush <= 0) {
    throw new Error('recordsPerFlush must be a positive integer');
  }
  if (!Number.isInteger(charactersPerFlush) || charactersPerFlush < 1024) {
    throw new Error('charactersPerFlush must be an integer of at least 1024');
  }
  const runsPath = path.join(dataPath, 'runs');
  const journalPath = path.join(runsPath, `${runId}.partial`);
  await mkdir(runsPath, { recursive: true });
  await mkdir(journalPath, { recursive: false });
  await writeJsonAtomic(path.join(journalPath, 'journal.json'), {
    schemaVersion: 1,
    runId,
    status: 'in_progress',
    startedAtUtc: startedAt.toISOString(),
    format: 'ndjson',
    note: 'Partial run evidence. A successful run replaces this directory with final JSON artifacts.',
  });

  const buffers = new Map();
  let writeTail = Promise.resolve();
  let writeError = null;

  function stream(name) {
    const normalized = safeName(name);
    if (!buffers.has(normalized)) {
      buffers.set(normalized, { lines: [], characters: 0 });
    }
    return { name: normalized, buffer: buffers.get(normalized) };
  }

  function queueFlush(name) {
    const { buffer } = stream(name);
    if (buffer.lines.length === 0) return;
    const content = `${buffer.lines.join('\n')}\n`;
    buffer.lines = [];
    buffer.characters = 0;
    const filePath = path.join(journalPath, `${name}.ndjson`);
    writeTail = writeTail.then(async () => {
      if (writeError) return;
      try {
        await appendFile(filePath, content, {
          encoding: 'utf8',
          mode: 0o600,
        });
      } catch (error) {
        writeError = error;
      }
    });
  }

  function record(name, value) {
    const target = stream(name);
    const line = JSON.stringify(value);
    target.buffer.lines.push(line);
    target.buffer.characters += line.length + 1;
    if (
      target.buffer.lines.length >= recordsPerFlush
      || target.buffer.characters >= charactersPerFlush
    ) {
      queueFlush(target.name);
    }
  }

  function recordMany(name, values) {
    for (const value of values ?? []) record(name, value);
  }

  async function flush() {
    for (const name of buffers.keys()) queueFlush(name);
    await writeTail;
    if (writeError) throw writeError;
  }

  async function checkpoint(stage, extra = {}) {
    await flush();
    await writeJsonAtomic(path.join(journalPath, 'checkpoint.json'), {
      schemaVersion: 1,
      runId,
      stage,
      updatedAtUtc: new Date().toISOString(),
      ...extra,
    });
  }

  async function* records(name) {
    await flush();
    const filePath = path.join(journalPath, `${safeName(name)}.ndjson`);
    try {
      await access(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const input = createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === '') continue;
      yield JSON.parse(line);
    }
  }

  async function remove() {
    await flush();
    await rm(journalPath, { recursive: true, force: true });
  }

  return {
    path: journalPath,
    record,
    recordMany,
    flush,
    checkpoint,
    records,
    remove,
  };
}
