import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createOpenCodeProofGraphPlugin } from "./core.mjs"

export const ProofGraphPlugin: Plugin = async ({ client, directory, worktree }) => {
  const logger = async (level: string, message: string, extra: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "proofgraph", level, message, extra } })
    } catch {}
  }
  return createOpenCodeProofGraphPlugin({
    directory,
    worktree,
    toolFactory: tool,
    schema: {
      object: (shape: Record<string, unknown>) => shape,
      string: () => tool.schema.string(),
      optional: (schema: any) => schema.optional(),
    },
    logger,
  }).hooks
}
