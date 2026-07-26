import fs from 'node:fs/promises';
import path from 'node:path';
import { PolicyError, ValidationError } from '../core/errors.mjs';
import { normalizeModelRegistry } from './model-router.mjs';

const MAX_REGISTRY_BYTES = 1_000_000;

export async function loadModelRegistryFile(filePath) {
  if (!filePath) return null;
  const resolved = path.resolve(String(filePath));
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink()) throw new PolicyError('Model registry symlink is not allowed');
  if (!stat.isFile()) throw new ValidationError('Model registry path must be a regular file');
  if (stat.size < 2 || stat.size > MAX_REGISTRY_BYTES) throw new ValidationError(`Model registry file exceeds ${MAX_REGISTRY_BYTES} bytes`);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(resolved, 'utf8')); }
  catch (error) { throw new ValidationError(`Model registry JSON is invalid: ${error.message}`); }
  return normalizeModelRegistry(parsed);
}

export async function loadConfiguredModelRegistry({ filePath = null, env = process.env } = {}) {
  const configured = filePath ?? env.PROOFGRAPH_MODEL_REGISTRY ?? null;
  return configured ? loadModelRegistryFile(configured) : null;
}

export const MODEL_REGISTRY_MAX_BYTES = MAX_REGISTRY_BYTES;
