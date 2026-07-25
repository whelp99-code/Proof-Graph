import path from 'node:path';
import { canonicalJson, sha256 } from '../../server/lib/canonical.mjs';
import { SecurityError, ValidationError } from '../../server/lib/errors.mjs';
import { arrayValue, assertFiniteJson, assertPlainObject, rejectUnknownKeys, stringValue } from '../../server/lib/validate.mjs';

const TYPES = new Set(['write_file', 'delete_file', 'apply_patch', 'run_command']);

export function safeRelativePath(input, name = 'path') {
  const value = stringValue(input, name, { min: 1, max: 4096 });
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) throw new SecurityError(`${name} must be relative`);
  const normalized = value.replaceAll('\\', '/');
  const pieces = normalized.split('/');
  if (pieces.some((part) => part === '..' || part === '' || part === '.')) throw new SecurityError(`${name} contains an unsafe segment`);
  if (pieces.some((part) => part === '.git')) throw new SecurityError(`${name} may not access .git`);
  return pieces.join('/');
}

function patchPaths(patchText) {
  const paths = [];
  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(/^(?:---|\+\+\+)\s+([^\t ]+)/);
    if (!match || match[1] === '/dev/null') continue;
    let candidate = match[1];
    if (candidate.startsWith('a/') || candidate.startsWith('b/')) candidate = candidate.slice(2);
    paths.push(safeRelativePath(candidate, 'patch path'));
  }
  if (!paths.length) throw new ValidationError('Patch contains no file paths');
  return [...new Set(paths)];
}

export function normalizeWorkspaceActions(input) {
  const actions = arrayValue(input, 'workspace_actions', { min: 1, max: 64 });
  const normalized = actions.map((raw, index) => {
    const action = assertPlainObject(raw, `workspace_actions[${index}]`);
    assertFiniteJson(action);
    const type = stringValue(action.type, `workspace_actions[${index}].type`, { min: 1, max: 40 });
    if (!TYPES.has(type)) throw new ValidationError(`Unsupported workspace action: ${type}`);
    if (type === 'write_file') {
      rejectUnknownKeys(action, ['type', 'path', 'content'], `workspace_actions[${index}]`);
      return {
        type,
        path: safeRelativePath(action.path, `workspace_actions[${index}].path`),
        content: stringValue(action.content, `workspace_actions[${index}].content`, { min: 0, max: 1_000_000, trim: false }),
      };
    }
    if (type === 'delete_file') {
      rejectUnknownKeys(action, ['type', 'path'], `workspace_actions[${index}]`);
      return { type, path: safeRelativePath(action.path, `workspace_actions[${index}].path`) };
    }
    if (type === 'apply_patch') {
      rejectUnknownKeys(action, ['type', 'patch'], `workspace_actions[${index}]`);
      const patch = stringValue(action.patch, `workspace_actions[${index}].patch`, { min: 8, max: 2_000_000, trim: false });
      return { type, patch, paths: patchPaths(patch) };
    }
    rejectUnknownKeys(action, ['type', 'argv', 'timeout_ms'], `workspace_actions[${index}]`);
    const argv = arrayValue(action.argv, `workspace_actions[${index}].argv`, { min: 1, max: 64 })
      .map((value, argIndex) => stringValue(value, `workspace_actions[${index}].argv[${argIndex}]`, { min: 1, max: 8192, trim: false }));
    return {
      type,
      argv,
      timeout_ms: action.timeout_ms === undefined ? null : action.timeout_ms,
    };
  });
  const encoded = canonicalJson(normalized);
  if (Buffer.byteLength(encoded, 'utf8') > 3_000_000) throw new ValidationError('workspace_actions exceed 3000000 bytes');
  return { actions: normalized, digest: sha256(encoded) };
}
