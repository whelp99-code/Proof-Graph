import { renderExecutionGraph, renderOrganizationGraph, renderCycles } from './graph-layout.mjs';

const RUN_SYMBOL = { active: '●', paused: 'Ⅱ', waiting_approval: '?', completed_clean: '✓', completed_with_recovery: '↺', simulation_complete: '≈', partial: '◐', failed: '!', denied: '×', aborted: '×', planned: '○', queued: '◇' };
function strip(value) { return String(value ?? '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/[\x00-\x1F\x7F]/g, ' '); }
function clip(value, width) { const text = strip(value); return text.length <= width ? text.padEnd(width) : `${text.slice(0, Math.max(0, width - 1))}…`; }
function border(width, left, middle, right) { return `${left}${middle.repeat(Math.max(0, width - 2))}${right}`; }
function joinColumns(columns, widths, separator = '│') {
  return columns.map((value, index) => clip(value, widths[index])).join(separator);
}
function elapsed(run) {
  if (!run?.updated_at) return '--';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(run.updated_at)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function runLines(runs, selected, width, height) {
  const lines = ['RUNS'];
  for (const [index, run] of runs.slice(0, Math.max(0, height - 1)).entries()) {
    const marker = index === selected ? '▶' : ' ';
    const symbol = RUN_SYMBOL[run.status] ?? '·';
    lines.push(`${marker}${symbol} ${run.run_id}`.slice(0, width));
    if (lines.length < height) lines.push(`   ${run.status} ${run.progress?.percent ?? 0}%`.slice(0, width));
  }
  return lines.slice(0, height);
}

function inspectorLines(run, selectedNode, width, height) {
  const lines = ['INSPECTOR'];
  if (!run) return lines;
  if (selectedNode) {
    lines.push(`Node: ${selectedNode.label}`, `Kind: ${selectedNode.kind}`, `Status: ${selectedNode.status}`, `Role: ${selectedNode.role_id ?? '-'}`, `Attempt: ${selectedNode.attempts}/${selectedNode.max_attempts}`);
    if (selectedNode.failure) lines.push(`Failure: ${selectedNode.failure.type}`, `${selectedNode.failure.message ?? ''}`);
  } else {
    lines.push(`Run: ${run.run_id}`, `Status: ${run.status}`, `Quality: ${run.quality_gate_passed ? 'PASS' : 'PENDING/FAIL'}`, `Progress: ${run.progress?.percent ?? 0}%`, `Host: ${run.host?.name ?? '-'} ${run.host?.status ?? ''}`);
  }
  lines.push('', `Loops: ${run.loop_summary?.total ?? 0}`, `Unresolved: ${run.failures?.unresolved?.length ?? run.failures?.length ?? 0}`, `Approvals: ${run.approvals?.pending?.length ?? 0}`);
  return lines.slice(0, height).map((line) => clip(line, width));
}

function timelineLines(run, width, height, query = '') {
  const needle = strip(query).trim().toLowerCase();
  const events = (run?.timeline ?? []).filter((event) => !needle || JSON.stringify(event).toLowerCase().includes(needle));
  const lines = ['TIMELINE'];
  for (const event of events.slice(-Math.max(0, height - 1))) {
    const time = event.at ? new Date(event.at).toISOString().slice(11, 19) : '--:--:--';
    let detail = event.data?.work_item_id ?? event.data?.failure_type ?? event.data?.status ?? '';
    if (event.type === 'route.changed') detail = `${event.data.from} → ${event.data.to} ${event.data.iteration}/${event.data.max_iterations}`;
    lines.push(`${time} ${event.type} ${detail}`.slice(0, width));
  }
  return lines.map((line) => clip(line, width));
}

function approvalLines(run, width, height) {
  const lines = ['APPROVAL QUEUE'];
  const approvals = run?.approvals?.pending ?? [];
  if (!approvals.length) lines.push('No pending approvals');
  for (const item of approvals.slice(0, Math.max(0, height - 1))) lines.push(`? ${item.kind} ${item.approval_id}`.slice(0, width), `${item.reason ?? ''}`.slice(0, width));
  return lines.slice(0, height).map((line) => clip(line, width));
}


function filtered(items, query) {
  const needle = strip(query).trim().toLowerCase();
  return (items ?? []).filter((item) => !needle || JSON.stringify(item).toLowerCase().includes(needle));
}

function contextLines(run, width, height, query = '') {
  const info = run?.intelligence?.contexts;
  const lines = [`CONTEXT DELIVERY  packets=${info?.total ?? 0} bytes=${info?.bytes ?? 0} redactions=${info?.redactions ?? 0} stale=${info?.stale_sources ?? 0} unknown=${info?.unknown_freshness_sources ?? 0}`];
  for (const packet of filtered(info?.packets, query).slice(-Math.max(0, height - 1)).reverse()) {
    lines.push(`◫ ${packet.role_type ?? '-'} ${packet.work_item_id ?? '-'} ${packet.token_estimate ?? 0}tok ${packet.byte_size ?? 0}B`);
    if (lines.length < height) lines.push(`  sections=${(packet.sections ?? []).join(',')} sources=${packet.source_count ?? 0} redacted=${packet.redaction_count ?? 0}`);
  }
  if (lines.length === 1) lines.push('No context packets');
  return lines.slice(0, height).map((line) => clip(line, width));
}

function modelLines(run, width, height, query = '') {
  const info = run?.intelligence?.routing;
  const lines = [`MODEL ROUTING  decisions=${info?.total ?? 0} observations=${info?.observation_total ?? 0} registry=${run?.intelligence?.model_registry_version ?? '-'}`];
  for (const model of filtered(info?.model_summary, query).slice(0, Math.min(3, Math.max(0, height - 1)))) {
    lines.push(`◎ ${model.model_id} success=${model.successes}/${model.observations} rate=${model.success_rate ?? '-'} avg=${model.average_latency_ms ?? 0}ms`);
  }
  for (const route of filtered(info?.decisions, query).slice(-Math.max(0, height - 1)).reverse()) {
    lines.push(`◆ ${route.work_item_id ?? '-'} → ${route.model_id ?? '-'} @${route.host ?? '-'} score=${route.score ?? '-'}`);
    if (lines.length < height) lines.push(`  cost=${route.estimated_cost_micros ?? 0}µ fallback=${(route.fallback_chain ?? []).join(' → ') || '-'}`);
  }
  if (lines.length === 1) lines.push('No route decisions');
  return lines.slice(0, height).map((line) => clip(line, width));
}

function collaborationLines(run, width, height, query = '') {
  const info = run?.intelligence?.collaboration;
  const lines = [`COLLABORATION  pending=${info?.pending ?? 0} completed=${info?.completed ?? 0} blocked=${info?.blocked ?? 0}`];
  for (const contract of filtered(info?.contracts, query).slice(-Math.max(0, height - 1)).reverse()) {
    const symbol = contract.status === 'completed' ? '✓' : ['blocked', 'rejected'].includes(contract.status) ? '!' : '○';
    lines.push(`${symbol} ${contract.type} ${contract.producer_role_id ?? '-'} → ${(contract.consumer_role_ids ?? []).join(',') || '-'}`);
    if (lines.length < height) lines.push(`  ${contract.status} ${contract.subject ?? ''}`);
  }
  if (lines.length === 1) lines.push('No work contracts');
  return lines.slice(0, height).map((line) => clip(line, width));
}

function knowledgeLines(run, width, height, query = '') {
  const info = run?.intelligence?.knowledge;
  const lines = [`KNOWLEDGE / IMPACT  nodes=${info?.node_count ?? 0} edges=${info?.edge_count ?? 0} actionable=${info?.actionable_impacts ?? 0}`];
  const impacts = filtered(info?.impacts, query).sort((a, b) => Number(b.action_required) - Number(a.action_required) || String(b.severity).localeCompare(String(a.severity)));
  for (const impact of impacts.slice(0, Math.max(0, height - 1))) {
    const symbol = impact.action_required ? '!' : '·';
    lines.push(`${symbol} ${impact.severity ?? '-'} ${impact.target_kind ?? '-'}:${impact.target_external_id ?? impact.target_id ?? '-'}`);
    if (lines.length < height) lines.push(`  source=${impact.source_work_item_id ?? impact.source_id ?? '-'} depth=${impact.depth ?? 0}`);
  }
  if (lines.length === 1) lines.push('No impact records');
  return lines.slice(0, height).map((line) => clip(line, width));
}

function memoryLines(run, width, height, query = '') {
  const info = run?.intelligence?.memory;
  const entries = filtered(info?.recalled, query);
  const lines = [`ORGANIZATION MEMORY  recalled=${info?.recalled?.length ?? 0} captured=${info?.captured?.length ?? 0}`];
  for (const entry of entries.slice(-Math.max(0, height - 1)).reverse()) {
    lines.push(`▣ ${entry.kind ?? '-'} ${entry.status ?? '-'} ${entry.title ?? entry.memory_id ?? '-'}`);
    if (lines.length < height) lines.push(`  confidence=${entry.confidence ?? '-'} score=${entry.retrieval_score ?? '-'} verifier=${entry.verified_by ?? '-'}`);
  }
  if (lines.length === 1) lines.push('No verified memories recalled');
  return lines.slice(0, height).map((line) => clip(line, width));
}

function verificationLines(run, width, height, query = '') {
  const entries = filtered(run?.intelligence?.verification, query);
  const lines = [`INTELLIGENCE VERIFICATION  reports=${entries.length}`];
  for (const report of entries.slice(-Math.max(0, height - 1)).reverse()) {
    lines.push(`${report.passed ? '✓' : '!'} ${report.scope ?? '-'} ${report.work_item_id ?? report.verification_id ?? '-'} checks=${report.check_count ?? 0}`);
    if (!report.passed && lines.length < height) lines.push(`  blocking=${(report.blocking_failures ?? []).join(',') || '-'}`);
  }
  if (lines.length === 1) lines.push('No verification reports');
  return lines.slice(0, height).map((line) => clip(line, width));
}

export function renderOperatorSnapshot({ runs = [], selectedRunIndex = 0, selectedNodeIndex = 0, view = 'graph', query = '', width = 120, height = 36, connected = true, message = '' } = {}) {
  width = Math.max(80, width); height = Math.max(24, height);
  const run = runs[selectedRunIndex] ?? null;
  const nodes = run?.graph?.nodes ?? [];
  const selectedNode = nodes[selectedNodeIndex] ?? nodes.find((node) => run?.current_node_ids?.includes(node.id)) ?? null;
  const leftWidth = Math.min(25, Math.max(19, Math.floor(width * 0.2)));
  const rightWidth = Math.min(34, Math.max(26, Math.floor(width * 0.25)));
  const centerWidth = width - leftWidth - rightWidth - 2;
  const bodyHeight = height - 11;
  const header = ` ProofGraph Operator  ${run ? `RUN ${run.run_id}  ${run.status.toUpperCase()}  ${run.host?.name ?? 'Host'} ${(run.host?.status ?? 'unknown').toUpperCase()}  ${run.progress?.percent ?? 0}%  ${elapsed(run)}` : 'NO RUN'} ${connected ? '[CONNECTED]' : '[DISCONNECTED]'}${query ? `  /${strip(query)}` : ''} `;
  const lines = [border(width, '┌', '─', '┐'), `│${clip(header, width - 2)}│`, border(width, '├', '─', '┤')];
  const left = runLines(runs, selectedRunIndex, leftWidth, bodyHeight);
  let center;
  if (view === 'org') center = renderOrganizationGraph(run?.organization, { width: centerWidth, height: bodyHeight });
  else if (view === 'cycles') center = renderCycles(run, { width: centerWidth, height: bodyHeight });
  else if (view === 'timeline') center = timelineLines(run, centerWidth, bodyHeight, query);
  else if (view === 'failures') {
    const needle = strip(query).trim().toLowerCase();
    const failures = (run?.failures?.unresolved ?? run?.failures ?? []).filter((failure) => !needle || JSON.stringify(failure).toLowerCase().includes(needle));
    center = ['FAILURE CENTER', ...failures.map((failure) => `! ${failure.type} ${failure.work_item_id ?? ''} ${failure.message ?? ''}`)];
    center = center.slice(0, bodyHeight).map((line) => clip(line, centerWidth));
  } else if (view === 'artifacts') {
    const needle = strip(query).trim().toLowerCase();
    const verified = (run?.artifacts?.verified ?? []).filter((item) => !needle || JSON.stringify(item).toLowerCase().includes(needle));
    const candidates = (run?.artifacts?.candidates ?? []).filter((item) => !needle || JSON.stringify(item).toLowerCase().includes(needle));
    center = ['ARTIFACTS', ...verified.map((item) => `✓ ${item.name ?? item.artifact_id ?? 'verified artifact'}`), ...candidates.map((item) => `○ ${item.name ?? item.artifact_id ?? 'candidate artifact'}`)];
    center = center.slice(0, bodyHeight).map((line) => clip(line, centerWidth));
  } else if (view === 'context') center = contextLines(run, centerWidth, bodyHeight, query);
  else if (view === 'models') center = modelLines(run, centerWidth, bodyHeight, query);
  else if (view === 'collaboration') center = collaborationLines(run, centerWidth, bodyHeight, query);
  else if (view === 'knowledge') center = knowledgeLines(run, centerWidth, bodyHeight, query);
  else if (view === 'memory') center = memoryLines(run, centerWidth, bodyHeight, query);
  else if (view === 'verification') center = verificationLines(run, centerWidth, bodyHeight, query);
  else center = ['EXECUTION GRAPH', ...renderExecutionGraph(run?.graph, { width: centerWidth, height: bodyHeight - 1, selectedNodeId: selectedNode?.id })];
  const right = inspectorLines(run, selectedNode, rightWidth, bodyHeight);
  for (let index = 0; index < bodyHeight; index += 1) lines.push(`│${joinColumns([left[index] ?? '', center[index] ?? '', right[index] ?? ''], [leftWidth, centerWidth, rightWidth])}│`);
  lines.push(border(width, '├', '─', '┤'));
  const bottomHeight = 4; const bottomLeft = Math.floor((width - 3) * 0.65); const bottomRight = width - 3 - bottomLeft;
  const timeline = timelineLines(run, bottomLeft, bottomHeight, query); const approvals = approvalLines(run, bottomRight, bottomHeight);
  for (let index = 0; index < bottomHeight; index += 1) lines.push(`│${joinColumns([timeline[index] ?? '', approvals[index] ?? ''], [bottomLeft, bottomRight])}│`);
  lines.push(border(width, '├', '─', '┤'));
  const keys = '[G]raph [O]rg [C]ycles [E]Context [M]odels [B]Contracts [W]Impact [Y]Memory [V]Verify [T]imeline [F]ailures [I]Artifacts [/]Search [?]Help [Q]Quit';
  lines.push(`│${clip(message ? `${message}  ${keys}` : keys, width - 2)}│`, border(width, '└', '─', '┘'));
  return lines.slice(0, height).join('\n');
}
