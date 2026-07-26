import { cloneJson, deepFreeze, deterministicId, sha256 } from '../core/canonical.mjs';
import { ConflictError, IntegrityError, PolicyError, ValidationError } from '../core/errors.mjs';
import { arrayValue, plainObject, stringValue, uniqueStrings } from '../core/validate.mjs';
import { CONTRACT_STATUSES, HANDOFF_PACKET_SCHEMA, WORK_CONTRACT_SCHEMA } from './domain.mjs';

const CONTRACT_TYPES = Object.freeze(['dependency_handoff', 'research_finding', 'plan_contract', 'implementation_change', 'verification_request', 'impact_followup', 'artifact_delivery']);

function normalizeRefs(refs, label) {
  return arrayValue(refs ?? [], label, { max: 256 }).map((item, index) => {
    plainObject(item, `${label}[${index}]`);
    return {
      type: stringValue(item.type, `${label}[${index}].type`, { max: 80 }),
      id: stringValue(item.id, `${label}[${index}].id`, { max: 256 }),
      digest: item.digest == null ? null : stringValue(item.digest, `${label}[${index}].digest`, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ }),
    };
  });
}

function contractDigest(contract) {
  const copy = cloneJson(contract); delete copy.digest; return sha256(copy);
}

function normalizeConsumerIds(ids) {
  const consumers = uniqueStrings(ids, 'consumer_role_ids', { max: 32, itemMax: 200 }).sort();
  if (consumers.length === 0) throw new ValidationError('At least one contract consumer is required');
  return consumers;
}

export class CollaborationRuntime {
  create({ mission_id, work_item_id, producer_role_id, consumer_role_ids, type = 'dependency_handoff', subject, deliverables = [], acceptance_criteria = [], evidence_requirements = [], input_refs = [], output_schema = null, idempotency_key = null, metadata = {} }) {
    const normalizedType = stringValue(type, 'contract type', { max: 80 });
    if (!CONTRACT_TYPES.includes(normalizedType)) throw new ValidationError(`Unsupported contract type: ${normalizedType}`);
    const consumers = normalizeConsumerIds(consumer_role_ids);
    const producer = stringValue(producer_role_id, 'producer_role_id', { max: 200 });
    if (consumers.includes(producer)) throw new PolicyError('Producer cannot be its own only collaboration consumer');
    const seed = { mission_id, work_item_id, producer, consumers, type: normalizedType, subject, idempotency_key };
    const contract = {
      schema: WORK_CONTRACT_SCHEMA,
      schema_version: 1,
      contract_id: deterministicId('contract', seed),
      mission_id: stringValue(mission_id, 'mission_id', { max: 200 }),
      work_item_id: stringValue(work_item_id, 'work_item_id', { max: 200 }),
      type: normalizedType,
      subject: stringValue(subject, 'subject', { min: 3, max: 2000 }),
      producer_role_id: producer,
      consumer_role_ids: consumers,
      deliverables: uniqueStrings(deliverables, 'deliverables', { max: 64, itemMax: 500 }),
      acceptance_criteria: uniqueStrings(acceptance_criteria, 'acceptance_criteria', { max: 128, itemMax: 1000 }),
      evidence_requirements: uniqueStrings(evidence_requirements, 'evidence_requirements', { max: 64, itemMax: 500 }),
      input_refs: normalizeRefs(input_refs, 'input_refs'),
      output_schema: output_schema == null ? null : cloneJson(output_schema),
      status: 'proposed',
      acknowledgements: [],
      completion: null,
      rejection: null,
      idempotency_key: idempotency_key ?? deterministicId('idem', seed),
      metadata: cloneJson(metadata),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    contract.digest = contractDigest(contract);
    return deepFreeze(contract);
  }

  transition(rawContract, { action, actor_role_id, reason = null, evidence_refs = [], output_refs = [] }) {
    this.verify(rawContract);
    const contract = cloneJson(rawContract);
    const actor = stringValue(actor_role_id, 'actor_role_id', { max: 200 });
    if (!['acknowledge', 'reject', 'block', 'complete', 'cancel'].includes(action)) throw new ValidationError(`Unsupported contract action: ${action}`);
    const consumer = contract.consumer_role_ids.includes(actor);
    if (['acknowledge', 'reject', 'block', 'complete'].includes(action) && !consumer) throw new PolicyError('Only an assigned consumer can transition this contract');
    if (contract.status === 'completed' || contract.status === 'cancelled' || contract.status === 'rejected') throw new ConflictError(`Contract is terminal: ${contract.status}`);
    const at = new Date().toISOString();
    if (action === 'acknowledge') {
      if (!contract.acknowledgements.some((item) => item.actor_role_id === actor)) contract.acknowledgements.push({ actor_role_id: actor, at });
      contract.status = contract.consumer_role_ids.every((id) => contract.acknowledgements.some((item) => item.actor_role_id === id)) ? 'acknowledged' : 'proposed';
    } else if (action === 'reject') {
      contract.status = 'rejected'; contract.rejection = { actor_role_id: actor, reason: stringValue(reason ?? 'contract rejected', 'reason', { max: 2000 }), at };
    } else if (action === 'block') {
      contract.status = 'blocked'; contract.rejection = { actor_role_id: actor, reason: stringValue(reason ?? 'contract blocked', 'reason', { max: 2000 }), at };
    } else if (action === 'cancel') {
      if (actor !== contract.producer_role_id) throw new PolicyError('Only producer can cancel a contract');
      contract.status = 'cancelled'; contract.rejection = { actor_role_id: actor, reason: stringValue(reason ?? 'contract cancelled', 'reason', { max: 2000 }), at };
    } else {
      if (actor === contract.producer_role_id) throw new PolicyError('Producer cannot self-complete its collaboration contract');
      const evidence = normalizeRefs(evidence_refs, 'evidence_refs');
      const outputs = normalizeRefs(output_refs, 'output_refs');
      if (contract.evidence_requirements.length > 0 && evidence.length === 0) throw new PolicyError('Contract completion requires evidence');
      if (contract.deliverables.length > 0 && outputs.length === 0) throw new PolicyError('Contract completion requires output references');
      contract.status = 'completed'; contract.completion = { actor_role_id: actor, evidence_refs: evidence, output_refs: outputs, at };
    }
    contract.updated_at = at;
    delete contract.digest; contract.digest = contractDigest(contract);
    return deepFreeze(contract);
  }

  handoff(contract, { context_packet_id, route_id, producer_output_refs = [] }) {
    this.verify(contract);
    if (!['acknowledged', 'proposed'].includes(contract.status)) throw new ConflictError(`Cannot hand off contract in ${contract.status}`);
    const packet = {
      schema: HANDOFF_PACKET_SCHEMA,
      schema_version: 1,
      handoff_id: deterministicId('handoff', { contract_id: contract.contract_id, context_packet_id, route_id, output_refs: producer_output_refs }),
      contract_id: contract.contract_id,
      mission_id: contract.mission_id,
      work_item_id: contract.work_item_id,
      producer_role_id: contract.producer_role_id,
      consumer_role_ids: cloneJson(contract.consumer_role_ids),
      context_packet_id: stringValue(context_packet_id, 'context_packet_id', { max: 200 }),
      route_id: stringValue(route_id, 'route_id', { max: 200 }),
      producer_output_refs: normalizeRefs(producer_output_refs, 'producer_output_refs'),
      acceptance_criteria: cloneJson(contract.acceptance_criteria),
      evidence_requirements: cloneJson(contract.evidence_requirements),
      created_at: new Date().toISOString(),
    };
    packet.digest = sha256(packet);
    return deepFreeze(packet);
  }

  dependencyContracts({ mission, workItem, dependencies }) {
    const contracts = [];
    for (const dependency of dependencies) {
      if (dependency.status !== 'completed') continue;
      if (dependency.assigned_role_id === workItem.assigned_role_id) continue;
      contracts.push(this.create({
        mission_id: mission.mission_id,
        work_item_id: workItem.work_item_id,
        producer_role_id: dependency.assigned_role_id,
        consumer_role_ids: [workItem.assigned_role_id],
        type: workItem.kind === 'verify' ? 'verification_request' : 'dependency_handoff',
        subject: `${dependency.stage_id} output handoff to ${workItem.stage_id}`,
        deliverables: dependency.output ? [`verified dependency output from ${dependency.stage_id}`] : [],
        acceptance_criteria: mission.task?.acceptance_criteria ?? [],
        evidence_requirements: workItem.kind === 'verify' ? ['independent evidence and explicit verdict'] : [],
        input_refs: [{ type: 'work_item', id: dependency.work_item_id, digest: sha256(dependency.output ?? null) }],
        idempotency_key: `dependency:${dependency.work_item_id}:${workItem.work_item_id}:${dependency.attempts}`,
      }));
    }
    return contracts;
  }

  impactFollowUps({ mission_id, producer_role_id, work_item_id, impacts, roleMap = {} }) {
    const contracts = [];
    for (const impact of impacts.slice(0, 64)) {
      const consumers = [];
      if (['api', 'service', 'file', 'test', 'artifact', 'requirement'].includes(impact.target_kind)) consumers.push(roleMap.verifier);
      if (['high', 'critical'].includes(impact.severity)) consumers.push(roleMap.risk ?? roleMap.verifier);
      const consumerIds = [...new Set(consumers.filter(Boolean))];
      if (!consumerIds.length || consumerIds.includes(producer_role_id) && consumerIds.length === 1) continue;
      contracts.push(this.create({
        mission_id, work_item_id, producer_role_id, consumer_role_ids: consumerIds,
        type: 'impact_followup', subject: `Impact follow-up for ${impact.target_id}`,
        deliverables: [`impact review for ${impact.target_id}`],
        acceptance_criteria: [`impact ${impact.impact_id} is explicitly accepted, mitigated, or rejected with evidence`],
        evidence_requirements: ['impact analysis evidence'],
        input_refs: [{ type: 'impact', id: impact.impact_id, digest: impact.digest ?? null }],
        idempotency_key: `impact:${impact.impact_id}:${consumerIds.join(',')}`,
        metadata: { severity: impact.severity, path: impact.path },
      }));
    }
    return contracts;
  }

  verify(contract) {
    plainObject(contract, 'work_contract');
    const digest = contract.digest;
    if (digest !== contractDigest(contract)) throw new IntegrityError('WorkContract digest mismatch');
    if (contract.schema !== WORK_CONTRACT_SCHEMA || !CONTRACT_STATUSES.includes(contract.status)) throw new ValidationError('Unsupported WorkContract schema or status');
    if (!Array.isArray(contract.consumer_role_ids) || contract.consumer_role_ids.length === 0) throw new ValidationError('WorkContract has no consumers');
    if (contract.consumer_role_ids.includes(contract.producer_role_id) && contract.consumer_role_ids.length === 1) throw new PolicyError('Self-only contract is not allowed');
    return { ok: true, contract_id: contract.contract_id, status: contract.status, digest };
  }
}
