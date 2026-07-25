# ProofGraph v1.0 Security Model

## Invariants

1. No successful graph path may bypass verification.
2. High-risk or irreversible paths require an approval node.
3. Adapter errors and failed work remain visible as typed failures.
4. Vendor adapters are disabled until explicitly enabled.
5. Subprocess adapters use argv and never invoke a command shell.
6. Workspace changes require a challenge-bound approved action digest.
7. Absolute paths, traversal, `.git`, and symlink escapes are rejected.
8. Debugger, graph, event, report, and workspace state are digest checked.
9. The Inspector is loopback-only by default and token protected.
10. Unknown MCP tools, unknown fields, prototype keys, oversized messages, and malformed output fail closed.

## Trust boundaries

- Model output is untrusted structured input.
- A configured coding-agent process is trusted only within its declared permissions and canary evidence.
- Git worktrees isolate files but do not isolate the network, process namespace, kernel, or host credentials.
- Human identity is self-attested at CLI/MCP/Claude host boundaries; approval challenges prove continuity, not cryptographic identity.
- Different agent roles are logical identities unless backed by separate credentials or workers.

## Production requirements

Use a container/VM for untrusted commands, a secret broker for credentials, least-privilege provider accounts, repository branch protection, mandatory review, and tool/version-specific canaries. Never enable broad host tools merely to make an adapter pass.
