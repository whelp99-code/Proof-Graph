import { ValidationError } from '../core/errors.mjs';

export const ARCHETYPES = Object.freeze(['direct', 'research', 'feature', 'bugfix', 'refactor', 'security', 'migration', 'operations', 'product']);
export const RISKS = Object.freeze(['low', 'medium', 'high', 'critical']);
export const REVERSIBILITY = Object.freeze(['reversible', 'partially_reversible', 'irreversible']);

const patterns = Object.freeze({
  security: [/security/i, /secure/i, /보안/, /취약/, /auth(?:entication|orization)?/i, /permission/i, /권한/],
  migration: [/migrat/i, /마이그레이션/, /upgrade/i, /업그레이드/, /schema change/i],
  bugfix: [/bug/i, /fix/i, /오류/, /버그/, /회귀/, /regression/i],
  refactor: [/refactor/i, /리팩터/, /구조 개선/, /cleanup/i],
  research: [/research/i, /조사/, /비교/, /분석/, /검증해/, /evaluate/i],
  operations: [/deploy/i, /배포/, /production/i, /운영/, /infrastructure/i, /인프라/, /database/i, /db\b/i],
  product: [/prd/i, /제품/, /시장/, /marketing/i, /마케팅/, /user flow/i, /와이어프레임/],
  feature: [/implement/i, /개발/, /구현/, /build/i, /create/i, /만들/, /add /i, /추가/],
});
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const REVERSIBILITY_RANK = Object.freeze({ reversible: 0, partially_reversible: 1, irreversible: 2 });

function conservativeEnum(explicit, inferred, allowed, rank, label) {
  if (explicit != null && !allowed.includes(explicit)) throw new ValidationError(`Unsupported ${label}: ${explicit}`);
  if (explicit == null) return inferred;
  return rank[explicit] >= rank[inferred] ? explicit : inferred;
}

function bounded(value, fallback) {
  if (value == null) return Math.round(fallback);
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new ValidationError('Signals must be 0..100');
  return Math.max(Math.round(value), Math.round(fallback));
}

export function classifyTask(objective, explicit = {}) {
  const text = String(objective ?? '').trim();
  if (text.length < 3) throw new ValidationError('Objective is too short');
  const inferredArchetype = Object.entries(patterns).find(([, list]) => list.some((pattern) => pattern.test(text)))?.[0] ?? 'direct';
  if (explicit.archetype && !ARCHETYPES.includes(explicit.archetype)) throw new ValidationError(`Unsupported archetype: ${explicit.archetype}`);
  // Explicit archetype may specialize an otherwise-direct goal, but cannot downgrade a strongly inferred action.
  const archetype = inferredArchetype === 'direct' ? (explicit.archetype ?? inferredArchetype) : inferredArchetype;
  const wordCount = text.split(/\s+/u).filter(Boolean).length;
  const listSignals = (text.match(/[\n,;]|\b(and|then|also)\b|그리고|또한|후에/giu) ?? []).length;
  const complexityBase = Math.min(100, 10 + wordCount * 1.4 + listSignals * 6 + (['feature', 'migration', 'operations', 'security'].includes(archetype) ? 18 : 0));
  const uncertaintyBase = Math.min(100, (/unknown|uncertain|investigate|조사|불명|검토|비교/i.test(text) ? 55 : 20) + (archetype === 'research' ? 25 : 0));
  let inferredRisk = 'low';
  if (/credential|secret|payment|법률|의료|재무|개인정보|결제/i.test(text)) inferredRisk = 'critical';
  else if (/delete|drop|production|prod\b|배포|삭제|publish|send|발송/i.test(text)) inferredRisk = 'high';
  else if (['security', 'operations', 'migration'].includes(archetype)) inferredRisk = 'medium';
  const risk = conservativeEnum(explicit.risk, inferredRisk, RISKS, RISK_RANK, 'risk');
  const inferredReversibility = /payment|결제|delete|drop|삭제/i.test(text) ? 'irreversible' : /deploy|publish|send|배포|게시|발송/i.test(text) ? 'partially_reversible' : 'reversible';
  const reversibility = conservativeEnum(explicit.reversibility, inferredReversibility, REVERSIBILITY, REVERSIBILITY_RANK, 'reversibility');
  const detectedExternalEffects = /deploy|publish|send|email|payment|production|배포|게시|발송|결제/i.test(text);
  const externalEffects = explicit.external_effects === true || detectedExternalEffects;
  const detectedResearch = archetype === 'research' || uncertaintyBase >= 55 || complexityBase >= 70;
  const detectedImplementation = ['feature', 'bugfix', 'refactor', 'migration', 'security', 'operations'].includes(archetype)
    || /implement|build|create|develop|구현|개발|만들/i.test(text);
  const requiresResearch = explicit.requires_research === true || detectedResearch;
  const requiresImplementation = explicit.requires_implementation === true || detectedImplementation;
  const inferredSubtasks = Math.max(1, Math.min(24, Math.ceil(complexityBase / 20) + (requiresResearch ? 1 : 0)));
  const requestedSubtasks = explicit.estimated_subtasks == null ? inferredSubtasks : Math.round(explicit.estimated_subtasks);
  if (!Number.isSafeInteger(requestedSubtasks) || requestedSubtasks < 1 || requestedSubtasks > 100) throw new ValidationError('estimated_subtasks must be 1..100');
  const estimatedSubtasks = Math.max(inferredSubtasks, requestedSubtasks);
  return {
    archetype,
    complexity: bounded(explicit.complexity, complexityBase),
    uncertainty: bounded(explicit.uncertainty, uncertaintyBase),
    risk,
    reversibility,
    external_effects: Boolean(externalEffects),
    requires_research: Boolean(requiresResearch),
    requires_implementation: Boolean(requiresImplementation),
    estimated_subtasks: estimatedSubtasks,
  };
}
