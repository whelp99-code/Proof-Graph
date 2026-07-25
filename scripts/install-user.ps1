param([switch]$Force)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Dest = Join-Path $HOME '.claude\skills\proofgraph-claude'
if ((Test-Path $Dest) -and -not $Force) {
  throw "Destination exists: $Dest. Re-run with -Force to replace it."
}
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Items = @('.claude-plugin', '.mcp.json', 'agents', 'hooks', 'server', 'skills', 'package.json', 'LICENSE', 'README.md', 'README_KO.md', 'ROADMAP.md', 'ROADMAP_KO.md', 'CHANGELOG.md', 'docs')
foreach ($Item in $Items) { Copy-Item -Recurse -Force (Join-Path $Root $Item) $Dest }
Write-Host "Installed ProofGraph Claude to $Dest"
Write-Host 'Restart Claude Code or run /reload-plugins.'
