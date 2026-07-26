import { canonicalJson, cloneJson, deterministicId, hmacSha256, sha256, timingSafeEqualHex } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';
import { capabilitySubset, delegableSubset } from './capabilities.mjs';

function normalizeBudget(value) {
  const out = {};
  for (const field of ['calls', 'tokens', 'cost_micros', 'wall_time_ms']) {
    const item = value?.[field] ?? 0;
    if (!Number.isSafeInteger(item) || item < 0) throw new ValidationError(`Invalid budget ${field}`);
    out[field] = item;
  }
  return out;
}

function budgetSubset(child, parent) {
  return Object.keys(child).every((key) => child[key] <= parent[key]);
}

export class DelegationAuthority {
  constructor({ secret, organization, now = () => Date.now() }) {
    if (!(typeof secret === 'string' || Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) throw new ValidationError('Delegation secret must contain at least 32 bytes');
    this.secret = secret;
    this.organization = organization;
    this.now = now;
    this.roles = new Map(organization.roles.map((role) => [role.role_id, role]));
  }

  sign(payload) { return hmacSha256(this.secret, payload); }

  issue({ issuer_role_id, subject_role_id, run_id, capabilities, budget, expires_at, parent_token = null, nonce = null }) {
    const issuer = this.roles.get(issuer_role_id);
    const subject = this.roles.get(subject_role_id);
    if (!issuer || !subject) throw new ValidationError('Unknown issuer or subject role');
    if (!issuer.can_delegate) throw new PolicyError(`Role cannot delegate: ${issuer_role_id}`);
    if (subject.role_type === 'human' || !subject.model_eligible) throw new PolicyError('Human/operator roles cannot receive delegated model tokens');
    const requested = [...new Set(capabilities)].sort();
    const normalizedBudget = normalizeBudget(budget);
    let ceilingCapabilities = delegableSubset(issuer.delegable_capabilities);
    let ceilingBudget = issuer.budget;
    let parentDigest = null;
    if (parent_token) {
      const parent = this.verify(parent_token, { run_id, subject_role_id: issuer_role_id });
      ceilingCapabilities = parent.capabilities;
      ceilingBudget = parent.budget;
      parentDigest = sha256(parent_token);
    }
    if (!capabilitySubset(requested, ceilingCapabilities)) throw new PolicyError('Delegated capabilities exceed issuer or parent token');
    if (!capabilitySubset(requested, subject.capabilities)) throw new PolicyError('Delegated capabilities exceed subject role');
    if (!budgetSubset(normalizedBudget, ceilingBudget) || !budgetSubset(normalizedBudget, subject.budget)) throw new PolicyError('Delegated budget exceeds ceiling');
    const expiry = new Date(expires_at).toISOString();
    if (Date.parse(expiry) <= this.now()) throw new PolicyError('Delegation token expiry must be in the future');
    const payload = {
      schema_version: 1,
      token_id: deterministicId('delegation', { issuer_role_id, subject_role_id, run_id, capabilities: requested, budget: normalizedBudget, expires_at: expiry, nonce: nonce ?? '' }),
      organization_id: this.organization.organization_id,
      issuer_role_id,
      subject_role_id,
      run_id,
      capabilities: requested,
      budget: normalizedBudget,
      issued_at: new Date(this.now()).toISOString(),
      expires_at: expiry,
      parent_digest: parentDigest,
      nonce: nonce ?? null,
    };
    return { payload, signature: this.sign(payload) };
  }

  verify(token, expected = {}) {
    if (!token?.payload || typeof token.signature !== 'string') throw new ValidationError('Malformed delegation token');
    if (!timingSafeEqualHex(token.signature, this.sign(token.payload))) throw new PolicyError('Invalid delegation signature');
    const payload = cloneJson(token.payload);
    if (payload.organization_id !== this.organization.organization_id) throw new PolicyError('Delegation organization mismatch');
    if (Date.parse(payload.expires_at) <= this.now()) throw new PolicyError('Delegation token expired');
    if (expected.run_id && payload.run_id !== expected.run_id) throw new PolicyError('Delegation run mismatch');
    if (expected.subject_role_id && payload.subject_role_id !== expected.subject_role_id) throw new PolicyError('Delegation subject mismatch');
    const subject = this.roles.get(payload.subject_role_id);
    if (!subject || !capabilitySubset(payload.capabilities, subject.capabilities)) throw new PolicyError('Delegation no longer fits subject policy');
    return payload;
  }

  attenuate(parentToken, { subject_role_id, capabilities, budget, expires_at, nonce = null }) {
    const parent = this.verify(parentToken);
    return this.issue({
      issuer_role_id: parent.subject_role_id,
      subject_role_id,
      run_id: parent.run_id,
      capabilities,
      budget,
      expires_at,
      parent_token: parentToken,
      nonce,
    });
  }
}

export class DelegationLedger {
  constructor() { this.entries = []; }
  append(action, token, actor) {
    const entry = { seq: this.entries.length + 1, at: new Date().toISOString(), action, actor, token_id: token.payload.token_id, token_digest: sha256(canonicalJson(token)) };
    entry.previous_hash = this.entries.at(-1)?.hash ?? '0'.repeat(64);
    entry.hash = sha256(entry);
    this.entries.push(entry);
    return entry;
  }
  verify() {
    let previous = '0'.repeat(64);
    for (const [index, entry] of this.entries.entries()) {
      const copy = { ...entry }; delete copy.hash;
      if (entry.seq !== index + 1 || entry.previous_hash !== previous || sha256(copy) !== entry.hash) throw new PolicyError(`Delegation ledger integrity failure at ${index + 1}`);
      previous = entry.hash;
    }
    return { ok: true, count: this.entries.length, head: previous };
  }
}
