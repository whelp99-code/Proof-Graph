const SYMBOL = Object.freeze({
  completed: '✓', running: '●', paused: 'Ⅱ', waiting_approval: '?', failed: '!', blocked: '×',
  pending: '○', ready: '◇', skipped: '–', cancelled: '×',
});

function card(node, selected, max = 24) {
  const symbol = SYMBOL[node.status] ?? '·';
  const loop = node.attempts > 1 ? ` ↺${node.attempts}` : '';
  const label = `${symbol} ${node.label}${loop}`;
  const clipped = label.length > max - 2 ? `${label.slice(0, max - 3)}…` : label;
  return selected ? `⟦${clipped}⟧` : `[${clipped}]`;
}

export function graphLevels(graph) {
  const nodes = graph?.nodes ?? [];
  const dependencies = (graph?.edges ?? []).filter((edge) => edge.kind === 'dependency');
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of dependencies) if (incoming.has(edge.to)) incoming.get(edge.to).push(edge.from);
  const memo = new Map(); const visiting = new Set();
  const level = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    visiting.add(id); const parents = incoming.get(id) ?? [];
    const result = parents.length ? 1 + Math.max(...parents.map(level)) : 0;
    visiting.delete(id); memo.set(id, result); return result;
  };
  const groups = new Map();
  for (const node of nodes) {
    const value = level(node.id); const group = groups.get(value) ?? []; group.push(node); groups.set(value, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0)));
}

function centered(line, width) {
  if (line.length >= width) return line.slice(0, width);
  const left = Math.max(0, Math.floor((width - line.length) / 2));
  return `${' '.repeat(left)}${line}`.padEnd(width);
}

export function renderExecutionGraph(graph, { width = 60, height = 24, selectedNodeId = null, foldCompleted = true, maxVisibleNodes = 80 } = {}) {
  let nodes = graph?.nodes ?? [];
  const active = new Set([...(graph?.active_node_ids ?? []), ...(graph?.next_node_ids ?? [])]);
  if (foldCompleted && nodes.length > maxVisibleNodes) {
    const focus = nodes.filter((node) => active.has(node.id) || node.status !== 'completed');
    const completed = nodes.filter((node) => node.status === 'completed');
    const keep = completed.slice(Math.max(0, completed.length - Math.max(5, maxVisibleNodes - focus.length)));
    const allowed = new Set([...focus, ...keep].map((node) => node.id));
    nodes = nodes.filter((node) => allowed.has(node.id)).slice(0, maxVisibleNodes);
  } else nodes = nodes.slice(0, maxVisibleNodes);
  const ids = new Set(nodes.map((node) => node.id));
  const local = { nodes, edges: (graph?.edges ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
  const levels = graphLevels(local); const lines = [];
  for (let index = 0; index < levels.length; index += 1) {
    const cards = levels[index].map((node) => card(node, node.id === selectedNodeId, Math.max(14, Math.floor((width - 4) / Math.max(1, levels[index].length)))));
    lines.push(centered(cards.join('  '), width));
    if (index < levels.length - 1) lines.push(centered('│', width), centered('▼', width));
  }
  const retries = (graph?.edges ?? []).filter((edge) => edge.kind === 'retry');
  if (retries.length) {
    lines.push('─'.repeat(Math.max(1, width)));
    for (const edge of retries.slice(-4)) {
      const from = graph.nodes.find((node) => node.id === edge.from)?.label ?? edge.from;
      const to = graph.nodes.find((node) => node.id === edge.to)?.label ?? edge.to;
      lines.push(`↺ ${from} → ${to}  ${edge.failure_type ?? ''}  ${edge.iteration ?? 1}/${edge.max_iterations ?? '?'}`.slice(0, width).padEnd(width));
    }
  }
  if ((graph?.nodes?.length ?? 0) > nodes.length) lines.push(`… ${(graph.nodes.length - nodes.length)} nodes folded`.padEnd(width));
  return lines.slice(0, height).map((line) => line.padEnd(width).slice(0, width));
}

export function renderOrganizationGraph(organization, { width = 60, height = 24 } = {}) {
  const lines = [];
  const departments = organization?.departments ?? [];
  const teams = organization?.teams ?? [];
  const roles = organization?.roles ?? [];
  for (const [dIndex, department] of departments.entries()) {
    lines.push(`${dIndex === departments.length - 1 ? '└' : '├'}─ ${department.name ?? department.department_id}`.slice(0, width));
    const deptTeams = teams.filter((team) => team.department_id === department.department_id);
    const deptRoles = roles.filter((role) => role.department_id === department.department_id);
    for (const team of deptTeams) lines.push(`   ├─ Team: ${team.name ?? team.team_id}`.slice(0, width));
    for (const role of deptRoles.slice(0, 8)) lines.push(`   ${role.role_type === 'human' ? '◆' : '◇'} ${role.role_id} → ${role.manager_role_id ?? 'root'}`.slice(0, width));
    if (deptRoles.length > 8) lines.push(`   … ${deptRoles.length - 8} more roles`);
  }
  return lines.slice(0, height).map((line) => line.padEnd(width).slice(0, width));
}

export function renderCycles(run, { width = 60, height = 24 } = {}) {
  const lines = [`OS Cycle ${run.cycle ?? 0}/${run.max_cycles ?? 0}`];
  for (const cycle of run.cycles ?? []) {
    const symbol = cycle.status === 'completed_clean' ? '✓' : cycle.status === 'completed_with_recovery' ? '↺' : cycle.status === 'failed' ? '!' : '●';
    lines.push(`${symbol} Cycle ${cycle.cycle}  ${cycle.mission_id}  ${cycle.status}  failures:${cycle.failures}`.slice(0, width));
    if (cycle.cycle < (run.cycles?.length ?? 0)) lines.push('   │', '   ▼');
  }
  return lines.slice(0, height).map((line) => line.padEnd(width).slice(0, width));
}
