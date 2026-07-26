import fs from 'node:fs/promises';
import path from 'node:path';
import { identifier } from '../core/validate.mjs';
import { normalizedEvent } from './contracts.mjs';

async function readLines(file) {
  try { return (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function readEvents(dataDir, runId, { namespace = 'missions', afterSeq = 0, limit = 500 } = {}) {
  const safeNamespace = identifier(namespace, 'namespace');
  const safeId = identifier(runId, 'run_id');
  const file = path.join(path.resolve(dataDir), safeNamespace, safeId, 'events.jsonl');
  const lines = await readLines(file);
  const events = [];
  for (const line of lines) {
    const envelope = JSON.parse(line);
    if (envelope.seq <= afterSeq) continue;
    events.push(normalizedEvent({ runId: safeId, source: safeNamespace === 'missions' ? 'mission' : 'organization_os', envelope }));
    if (events.length >= limit) break;
  }
  return events;
}

export function summarizeTimeline(events, limit = 100) {
  return events.slice(-limit).map((event) => ({
    event_id: event.event_id,
    seq: event.seq,
    at: event.at,
    type: event.type,
    actor: event.actor,
    data: event.data,
  }));
}
