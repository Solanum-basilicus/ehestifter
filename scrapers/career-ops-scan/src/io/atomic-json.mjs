import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

/**
 * Write JSON without exposing a partially-written destination file.
 *
 * The temporary file is created in the destination directory so rename stays
 * on the same filesystem. Existing destination content is left untouched until
 * the complete temporary file has been written and flushed.
 */
export async function writeJsonAtomic(filePath, value) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('filePath must be a non-empty string');
  }

  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle = null;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8',
    );
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
