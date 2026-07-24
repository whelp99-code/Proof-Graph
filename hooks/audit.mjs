#!/usr/bin/env node
import { appendHookAudit, readHookInput } from './hook-lib.mjs';

try {
  const payload = await readHookInput();
  const eventName = String(payload.hook_event_name || 'Unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  await appendHookAudit(payload, `claude.${eventName}`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`[proofgraph-claude] audit hook error: ${error.message}\n`);
  process.exit(0);
}
