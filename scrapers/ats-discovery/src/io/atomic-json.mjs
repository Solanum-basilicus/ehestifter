import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

function resolveAtomicPaths(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('filePath must be a non-empty string');
  }
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  return { destination, directory, temporaryPath };
}

async function writeUtf8(handle, value) {
  const buffer = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten <= 0) {
      throw new Error('Could not make progress writing JSON artifact');
    }
    offset += bytesWritten;
  }
}

async function writeAtomic(filePath, writeContent) {
  if (typeof writeContent !== 'function') {
    throw new TypeError('writeContent must be a function');
  }
  const { destination, directory, temporaryPath } = resolveAtomicPaths(filePath);
  await mkdir(directory, { recursive: true });

  let handle = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await writeContent(handle);
    await handle.sync();
    await handle.close();
    handle = null;

    await rename(temporaryPath, destination);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Write JSON without exposing a partially-written destination file.
 *
 * The temporary file is created in the destination directory so rename stays
 * on the same filesystem. Existing destination content is left untouched until
 * the complete temporary file has been written and flushed.
 */
export async function writeJsonAtomic(filePath, value) {
  await writeAtomic(filePath, async (handle) => {
    await handle.writeFile(
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
  });
}

/**
 * Atomically write an object whose largest field is an array, serializing one
 * array item at a time instead of constructing one process-sized JSON string.
 *
 * The output remains ordinary JSON and can be consumed with jq or JSON.parse.
 * Header values should remain small; large collections belong in `items`.
 */
export async function writeJsonArrayEnvelopeAtomic(filePath, {
  header = {},
  arrayProperty,
  items,
  chunkSizeCharacters = 1_048_576,
}) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    throw new TypeError('header must be an object');
  }
  if (typeof arrayProperty !== 'string' || arrayProperty.trim() === '') {
    throw new TypeError('arrayProperty must be a non-empty string');
  }
  if (Object.hasOwn(header, arrayProperty)) {
    throw new Error(`header must not contain array property ${arrayProperty}`);
  }
  if (!items || typeof items[Symbol.iterator] !== 'function') {
    throw new TypeError('items must be iterable');
  }
  if (!Number.isInteger(chunkSizeCharacters) || chunkSizeCharacters < 1024) {
    throw new TypeError('chunkSizeCharacters must be an integer of at least 1024');
  }

  await writeAtomic(filePath, async (handle) => {
    let chunk = '{\n';
    async function append(value) {
      if (chunk.length > 0 && chunk.length + value.length > chunkSizeCharacters) {
        await writeUtf8(handle, chunk);
        chunk = '';
      }
      if (value.length > chunkSizeCharacters) {
        if (chunk.length > 0) {
          await writeUtf8(handle, chunk);
          chunk = '';
        }
        await writeUtf8(handle, value);
        return;
      }
      chunk += value;
    }

    for (const [key, value] of Object.entries(header)) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new TypeError(`header property ${key} is not JSON serializable`);
      }
      await append(`  ${JSON.stringify(key)}: ${serialized},\n`);
    }
    await append(`  ${JSON.stringify(arrayProperty)}: [`);

    let first = true;
    let index = 0;
    for (const item of items) {
      const serialized = JSON.stringify(item);
      if (serialized === undefined) {
        throw new TypeError(`array item ${index} is not JSON serializable`);
      }
      await append(`${first ? '\n' : ',\n'}    ${serialized}`);
      first = false;
      index += 1;
    }
    if (!first) await append('\n');
    await append('  ]\n}\n');
    if (chunk.length > 0) await writeUtf8(handle, chunk);
  });
}
