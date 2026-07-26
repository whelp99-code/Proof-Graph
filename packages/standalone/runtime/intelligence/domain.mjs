export const INTELLIGENCE_SCHEMA_VERSION = 1;
export const CONTEXT_PACKET_SCHEMA = 'proofgraph.context-packet.v1';
export const MODEL_REGISTRY_SCHEMA = 'proofgraph.model-registry.v1';
export const ROUTE_DECISION_SCHEMA = 'proofgraph.route-decision.v1';
export const MODEL_OBSERVATION_SCHEMA = 'proofgraph.model-observation.v1';
export const WORK_CONTRACT_SCHEMA = 'proofgraph.work-contract.v1';
export const HANDOFF_PACKET_SCHEMA = 'proofgraph.handoff-packet.v1';
export const KNOWLEDGE_GRAPH_SCHEMA = 'proofgraph.knowledge-graph.v1';
export const MEMORY_ENTRY_SCHEMA = 'proofgraph.memory-entry.v1';
export const INTELLIGENCE_VERIFICATION_SCHEMA = 'proofgraph.intelligence-verification.v1';

export const DATA_CLASSIFICATIONS = Object.freeze(['public', 'internal', 'confidential', 'restricted']);
export const CONTRACT_STATUSES = Object.freeze(['proposed', 'acknowledged', 'rejected', 'blocked', 'completed', 'cancelled']);
export const MEMORY_STATUSES = Object.freeze(['proposed', 'verified', 'superseded', 'rejected']);
export const MEMORY_KINDS = Object.freeze(['decision', 'constraint', 'artifact', 'lesson', 'failure', 'verification', 'preference']);
export const KNOWLEDGE_NODE_KINDS = Object.freeze(['task', 'requirement', 'role', 'work_item', 'artifact', 'file', 'api', 'service', 'test', 'decision', 'memory']);
export const KNOWLEDGE_EDGE_KINDS = Object.freeze(['depends_on', 'produces', 'consumes', 'modifies', 'verifies', 'impacts', 'decided_by', 'supersedes', 'relates_to']);
