import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tempDir(prefix = 'proofgraph-v2-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 });
}

export function jsonClone(value) { return JSON.parse(JSON.stringify(value)); }
