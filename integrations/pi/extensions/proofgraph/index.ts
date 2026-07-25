import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { createPiProofGraphExtension } from "../../core.mjs"

export default function proofGraphPiExtension(pi: ExtensionAPI) {
  return createPiProofGraphExtension(pi, {
    schema: {
      object: (shape: Record<string, unknown>) => Type.Object(shape as any),
      string: () => Type.String(),
      optional: (schema: any) => Type.Optional(schema),
    },
  })
}
