import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function atomicWriteFile(filePath, content, { mode = 0o600 } = {}) {
  await ensureDir(path.dirname(filePath));
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const tempPath = `${filePath}.tmp-${suffix}`;
  await fs.writeFile(tempPath, content, { encoding: Buffer.isBuffer(content) ? undefined : 'utf8', mode });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      await fs.rm(filePath, { force: true });
      await fs.rename(tempPath, filePath);
    } else {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function acquireFileLock(lockPath, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  await ensureDir(path.dirname(lockPath));
  const started = Date.now();
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
}
