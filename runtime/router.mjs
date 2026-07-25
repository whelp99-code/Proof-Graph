import { StateError } from '../server/lib/errors.mjs';

export class AgentRouter {
  constructor(config, registry) {
    this.config = config;
    this.registry = registry;
  }

  select(node, override = undefined) {
    const requested = override
      ?? node.metadata?.adapter
      ?? this.config.routing[node.role]
      ?? this.config.routing[node.kind]
      ?? this.config.default_adapter;
    if (!this.registry.has(requested)) {
      throw new StateError(`No registered adapter for node ${node.node_id}: ${requested}`, {
        node_id: node.node_id,
        role: node.role,
        kind: node.kind,
        requested_adapter: requested,
      });
    }
    return { name: requested, adapter: this.registry.get(requested) };
  }
}
