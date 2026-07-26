import crypto from 'node:crypto';
import { canonicalJson, cloneJson, deterministicId, sha256 } from '../core/canonical.mjs';
import { IntegrityError, ValidationError } from '../core/errors.mjs';

export function generateSigningKeyPair() {
  return crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export function signRegistryPackage({ manifest, payload }, privateKey) {
  if (!manifest || !payload) throw new ValidationError('Package manifest and payload are required');
  const envelope = {
    schema_version: 1,
    package_id: manifest.package_id ?? deterministicId('package', { manifest, payload_digest: sha256(payload) }),
    manifest: cloneJson(manifest),
    payload: cloneJson(payload),
    payload_digest: sha256(payload),
  };
  envelope.envelope_digest = sha256(envelope);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(envelope)), privateKey).toString('base64');
  return { envelope, signature, algorithm: 'Ed25519' };
}

export function verifyRegistryPackage(signed, publicKey) {
  if (signed?.algorithm !== 'Ed25519' || !signed.envelope || typeof signed.signature !== 'string') throw new ValidationError('Malformed signed package');
  const envelope = cloneJson(signed.envelope);
  if (envelope.payload_digest !== sha256(envelope.payload)) throw new IntegrityError('Registry package payload digest mismatch');
  const digest = envelope.envelope_digest; delete envelope.envelope_digest;
  if (digest !== sha256(envelope)) throw new IntegrityError('Registry package envelope digest mismatch');
  envelope.envelope_digest = digest;
  const ok = crypto.verify(null, Buffer.from(canonicalJson(envelope)), publicKey, Buffer.from(signed.signature, 'base64'));
  if (!ok) throw new IntegrityError('Registry package signature verification failed');
  return { ok: true, package_id: envelope.package_id, payload_digest: envelope.payload_digest };
}

export class PackageRegistry {
  constructor() { this.packages = new Map(); }
  publish(signed, publicKey) {
    const verified = verifyRegistryPackage(signed, publicKey);
    if (this.packages.has(verified.package_id)) throw new ValidationError('Package already published');
    this.packages.set(verified.package_id, cloneJson(signed));
    return verified;
  }
  get(packageId) { return cloneJson(this.packages.get(packageId) ?? null); }
  list() { return [...this.packages.keys()].sort(); }
}
