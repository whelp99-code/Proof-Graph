export const HOST_CONTRACT_TARGETS = Object.freeze({
  opencode: Object.freeze({
    cli_version: '1.18.4',
    plugin_version: '1.18.4',
    node_minimum: '20.0.0',
    dependency: Object.freeze({ name: '@opencode-ai/plugin', version: '1.18.4' }),
  }),
  pi: Object.freeze({
    cli_version: '0.82.0',
    node_minimum: '22.19.0',
    peer_dependencies: Object.freeze({
      '@earendil-works/pi-coding-agent': '*',
      typebox: '*',
    }),
  }),
});

export function extractSemanticVersion(value) {
  const match = String(value ?? '').match(/(?:^|[^0-9])v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:$|[^0-9])/);
  if (!match) return null;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
}

export function compareSemanticVersions(left, right) {
  const a = extractSemanticVersion(left);
  const b = extractSemanticVersion(right);
  if (!a || !b) return null;
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (aa[index] < bb[index]) return -1;
    if (aa[index] > bb[index]) return 1;
  }
  return 0;
}

export function meetsMinimumVersion(actual, minimum) {
  const compared = compareSemanticVersions(actual, minimum);
  return compared == null ? null : compared >= 0;
}
