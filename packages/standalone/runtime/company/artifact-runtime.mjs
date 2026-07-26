import { deterministicId, sha256, cloneJson } from '../core/canonical.mjs';
import { PolicyError, ValidationError } from '../core/errors.mjs';

export class ArtifactRuntime {
  candidateFromReport(report, workItem) {
    if (report.status !== 'success') throw new PolicyError('Failed report cannot create artifact candidates');
    const deliverables = Array.isArray(report.output?.deliverables) ? report.output.deliverables : [];
    return deliverables.map((item, index) => {
      if (!item || typeof item.name !== 'string') throw new ValidationError('Artifact deliverable requires name');
      const artifact = {
        schema_version: 1,
        artifact_id: deterministicId('artifact', { report: report.integrity?.report_digest, index, name: item.name }),
        name: item.name,
        media_type: item.media_type ?? 'application/json',
        content: cloneJson(item.content ?? item),
        status: 'candidate',
        producer_role_id: workItem.assigned_role_id,
        source_work_item_id: workItem.work_item_id,
        source_run_id: report.run_id,
        source_report_digest: report.integrity?.report_digest ?? null,
        verifier_role_id: null,
        verification_evidence: [],
      };
      artifact.content_digest = sha256(artifact.content);
      artifact.digest = sha256(artifact);
      return artifact;
    });
  }

  promote(candidates, verificationReport, verifierWorkItem) {
    if (verificationReport.status !== 'success' || verificationReport.verification?.passed !== true || verificationReport.verification?.independent !== true) {
      throw new PolicyError('Artifacts require a successful independent verification report');
    }
    if (verifierWorkItem.assigned_role_id === candidates[0]?.producer_role_id) throw new PolicyError('Artifact producer cannot verify its own artifacts');
    return candidates.map((candidate) => {
      const artifact = cloneJson(candidate);
      artifact.status = 'verified';
      artifact.verifier_role_id = verifierWorkItem.assigned_role_id;
      artifact.verification_evidence = cloneJson(verificationReport.verification.evidence ?? []);
      artifact.verification_report_digest = verificationReport.integrity?.report_digest ?? null;
      delete artifact.digest;
      artifact.digest = sha256(artifact);
      return artifact;
    });
  }

  verify(artifact) {
    const digest = artifact.digest;
    const copy = cloneJson(artifact); delete copy.digest;
    if (digest !== sha256(copy)) throw new PolicyError(`Artifact digest mismatch: ${artifact.artifact_id}`);
    if (artifact.content_digest !== sha256(artifact.content)) throw new PolicyError(`Artifact content mismatch: ${artifact.artifact_id}`);
    return true;
  }
}
