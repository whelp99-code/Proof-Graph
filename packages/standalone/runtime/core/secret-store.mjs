import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyError, ValidationError } from './errors.mjs';

function secretFileName(value) {
  const name = String(value ?? '').trim();
  if (!/^\.[a-z0-9][a-z0-9._-]{2,80}$/i.test(name) || name.includes('..')) {
    throw new ValidationError('Secret filename must be a bounded hidden basename');
  }
  return name;
}

async function readExisting(file) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new PolicyError(`Secret path must be a regular file: ${file}`);
  if ((stat.mode & 0o077) !== 0) await fs.chmod(file, 0o600);
  const secret = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(secret)) throw new PolicyError(`Stored secret has an invalid format: ${file}`);
  return secret;
}

/**
 * Load a stable per-data-directory secret or create one with mode 0600.
 * A caller-provided secret is accepted for controlled tests/deployments but is
 * never written to disk by this helper.
 */
export async function loadOrCreateSecret(root, { filename = '.approval-secret', bytes = 32, provided = null } = {}) {
  if (provided != null) {
    if (typeof provided !== 'string' || Buffer.byteLength(provided) < 32) throw new ValidationError('Provided secret must contain at least 32 bytes');
    return provided;
  }
  if (!Number.isSafeInteger(bytes) || bytes < 32 || bytes > 128) throw new ValidationError('Secret bytes must be 32..128');
  const directory = path.resolve(root);
  const file = path.join(directory, secretFileName(filename));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await readExisting(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const secret = crypto.randomBytes(bytes).toString('base64url');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(`${secret}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await fs.chmod(file, 0o600);
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readExisting(file);
  }
}
