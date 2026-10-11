import { makeEvidenceKey, fingerprintDependencies, canReuseEvidence } from './evidence-cache.mjs';
import { recordRevision, requireString } from './agent-state.mjs';

function evidenceIdentity(input) {
  // The cache helper validates JSON data without coercion or serialization loss.
  makeEvidenceKey({ params: input });
  const kind = requireString(input?.kind, 'kind');
  const target = requireString(input?.target, 'target');
  if (!Array.isArray(input.dependencies)) throw new TypeError('Dependencies must be supplied explicitly');
  const dependencyFingerprint = fingerprintDependencies(input.dependencies);
  const identity = { kind, target, params: input.params ?? null, dependencies: [...new Set(input.dependencies)].sort() };
  const key = makeEvidenceKey(identity);
  if (Object.hasOwn(input, 'key') && input.key !== key) throw new TypeError('Evidence key does not match identity');
  if (Object.hasOwn(input, 'dependencyFingerprint') && input.dependencyFingerprint !== dependencyFingerprint) {
    throw new TypeError('Evidence dependency fingerprint does not match dependencies');
  }
  return { ...identity, key, dependencyFingerprint };
}

export function normalizeEvidenceRecord(input) {
  const identity = evidenceIdentity(input);
  const evidenceId = requireString(input.evidenceId, 'evidenceId');
  fingerprintDependencies(input.dependencyIds);
  if (!Array.isArray(input.dependencyIds)) throw new TypeError('Dependency IDs must be supplied explicitly');
  if (input.dependencies.length && !input.dependencyIds.length) throw new TypeError('Dependency IDs are required for invalidation');
  if (!['fresh', 'probably_fresh', 'stale', 'invalidated'].includes(input.freshness)) {
    throw new TypeError('Invalid evidence freshness');
  }
  recordRevision(input);
  const record = { ...structuredClone(input), ...identity, evidenceId, dependencyIds: [...new Set(input.dependencyIds)].sort() };
  delete record.revision;
  // Observation registration assigns its own link after validation.
  delete record.observationId;
  return record;
}

export function evidenceQuery(input) {
  const identity = evidenceIdentity(input);
  const risk = input.risk ?? 'low';
  if (!['low', 'medium', 'high'].includes(risk)) throw new TypeError('Invalid evidence risk');
  return { ...identity, risk };
}

export function reusableEvidence(project, query) {
  const record = project.efficiency.evidenceCache.find(item => item?.key === query.key);
  if (!record) return null;
  // Unknown additive legacy cache data is retained, but cannot certify reuse.
  try {
    normalizeEvidenceRecord(record);
    return canReuseEvidence(record, query) ? record : null;
  } catch {
    return null;
  }
}

export function upsertEvidence(project, validated) {
  const cache = project.efficiency.evidenceCache;
  const index = cache.findIndex(item => item?.key === validated.key);
  const previous = index < 0 ? {} : { ...cache[index] };
  if (previous.evidenceId !== validated.evidenceId) {
    delete previous.result;
    delete previous.observationId;
  }
  const record = { ...previous, ...validated };
  if (index < 0) cache.push(record);
  else cache[index] = record;
  return record;
}

