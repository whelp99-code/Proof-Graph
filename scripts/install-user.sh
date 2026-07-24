#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${HOME}/.claude/skills/proofgraph-claude"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1
if [[ -e "$DEST" && "$FORCE" -ne 1 ]]; then
  echo "Destination exists: $DEST" >&2
  echo "Re-run with --force to replace it." >&2
  exit 2
fi
rm -rf "$DEST"
mkdir -p "$DEST"
for item in .claude-plugin .mcp.json agents hooks server skills package.json LICENSE README.md README_KO.md docs; do
  cp -R "$ROOT/$item" "$DEST/"
done
printf 'Installed ProofGraph Claude to %s\nRestart Claude Code or run /reload-plugins.\n' "$DEST"
