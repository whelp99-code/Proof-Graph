import { AdapterError } from './base.mjs';

function parseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const variants = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) variants.push(fenced[1]);
  const marker = trimmed.match(/(?:PROOFGRAPH_RESULT\s*[:=]|<proofgraph_result>)\s*([\s\S]*?)(?:<\/proofgraph_result>|$)/i);
  if (marker) variants.push(marker[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) variants.push(trimmed.slice(start, end + 1));
  for (const candidate of variants) {
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function hasResultShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.outcome === 'string' && typeof value.summary === 'string';
}

function collect(value, out, depth = 0, seen = new Set()) {
  if (depth > 12 || value == null) return;
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    if (parsed != null) collect(parsed, out, depth + 1, seen);
    return;
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (hasResultShape(value)) out.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1, seen);
    return;
  }
  const priority = ['result', 'output', 'text', 'content', 'message', 'item', 'part', 'assistantMessage', 'assistant_message', 'messages', 'response'];
  for (const key of priority) if (key in value) collect(value[key], out, depth + 1, seen);
  for (const [key, child] of Object.entries(value)) {
    if (!priority.includes(key)) collect(child, out, depth + 1, seen);
  }
}

export function parseAgentResultFromOutput(stdout, options = {}) {
  const candidates = [];
  const direct = parseJson(stdout);
  if (direct != null) collect(direct, candidates);
  const lines = String(stdout ?? '').split('\n');
  const events = [];
  for (const line of lines) {
    const parsed = parseJson(line);
    if (parsed != null) {
      events.push(parsed);
      collect(parsed, candidates);
    }
  }
  if (candidates.length) return { result: candidates.at(-1), events };
  throw new AdapterError(`No ProofGraph AgentResult JSON found in ${options.source ?? 'adapter'} output`, {
    source: options.source ?? 'adapter',
    stdout_excerpt: String(stdout ?? '').slice(-20_000),
    parsed_events: events.length,
  });
}
