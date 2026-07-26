import { deterministicId, sha256, cloneJson } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';


function proposalDigest(proposal) {
  const copy = cloneJson(proposal);
  delete copy.digest;
  delete copy.status;
  delete copy.executed;
  delete copy.receipt_id;
  return sha256(copy);
}

export class DeliveryRuntime {
  constructor({ adapter = null } = {}) {
    if (adapter && (!adapter.manifest || typeof adapter.manifest.external_effects !== 'boolean' || typeof adapter.execute !== 'function')) throw new ValidationError('Delivery adapter requires manifest.external_effects and execute()');
    this.adapter = adapter;
  }

  propose({ mission_id, artifacts, target = 'local-review', external_effect = false, reversible = true }) {
    external_effect = external_effect || this.adapter?.manifest?.external_effects === true;
    if (!Array.isArray(artifacts) || artifacts.length === 0) throw new ValidationError('Delivery requires artifacts');
    if (artifacts.some((artifact) => artifact.status !== 'verified')) throw new PolicyError('Only verified artifacts can be delivered');
    const proposal = {
      schema_version: 1,
      delivery_id: deterministicId('delivery', { mission_id, artifacts: artifacts.map((item) => item.digest), target, external_effect }),
      mission_id,
      artifact_ids: artifacts.map((item) => item.artifact_id),
      target,
      external_effect,
      reversible,
      approval_required: external_effect || !reversible,
      status: external_effect || !reversible ? 'waiting_approval' : 'ready',
      executed: false,
    };
    proposal.digest = proposalDigest(proposal);
    return proposal;
  }

  async execute(proposal, { approval = null } = {}) {
    const digest = proposal.digest;
    if (digest !== proposalDigest(proposal)) throw new PolicyError('Delivery proposal digest mismatch');
    if (proposal.approval_required) {
      if (approval?.status !== 'approved' || approval?.actor !== 'external-human'
        || approval?.delivery_id !== proposal.delivery_id || approval?.proposal_digest !== proposal.digest) {
        throw new PolicyError('Delivery requires proposal-bound external approval');
      }
    }
    if (this.adapter?.manifest?.external_effects === true && approval?.status !== 'approved') {
      throw new PolicyError('External delivery adapter requires explicit approval before invocation');
    }
    if (proposal.executed) throw new PolicyError('Delivery already executed');
    const result = this.adapter
      ? await this.adapter.execute(cloneJson(proposal))
      : { dry_run: true, target: proposal.target, message: 'No external delivery adapter configured; verified package prepared only.' };
    const receipt = {
      schema_version: 1,
      receipt_id: deterministicId('receipt', { delivery_id: proposal.delivery_id, result }),
      delivery_id: proposal.delivery_id,
      status: 'completed',
      external_effect_observed: Boolean(result?.external_effect_observed),
      dry_run: result?.dry_run !== false,
      result: cloneJson(result),
      approval_id: approval?.approval_id ?? null,
      approval_digest: approval ? sha256(approval) : null,
    };
    receipt.digest = sha256(receipt);
    return receipt;
  }
}
