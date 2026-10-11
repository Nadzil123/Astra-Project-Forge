import { recordRevision } from './agent-state.mjs';
import { getStateIdentity } from './coordination-core.mjs';

const sections = {
  goal: project => project.goalGraph,
  claim: project => project.claims,
  plan: project => project.plans,
  evaluation: project => project.evaluations,
  evidence: project => project.efficiency?.evidenceCache,
  observation: project => project.observations,
  failedStrategy: project => project.efficiency?.failedStrategies,
  checkpoint: project => project.checkpoints,
  adaptation: project => project.adaptations,
  transfer: project => project.transferCandidates,
  lesson: project => project.lessons,
  hypothesis: project => project.hypotheses,
  experiment: project => project.experiments,
};
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const recordId = (kind, record) => kind === 'evidence' ? record?.key : record?.id;
const isRecord = record => record && typeof record === 'object' && !Array.isArray(record);

export function makeStateRef(project, kind, record) {
  if (!Object.hasOwn(sections, kind)) throw new TypeError('Unsupported reference kind');
  if (!isRecord(record) || !nonempty(recordId(kind, record))) throw new TypeError('Record has no resolvable identity');
  const { projectId, epoch } = getStateIdentity(project);
  return { projectId, epoch, kind, id: recordId(kind, record), revision: recordRevision(record) };
}

// Legacy strings (notably lessons) remain available through full context. They
// do not acquire invented IDs simply to fit the reference protocol.
export function listStateRefs(project) {
  return Object.entries(sections).flatMap(([kind, read]) => (read(project) ?? [])
    .filter(record => isRecord(record) && nonempty(recordId(kind, record)))
    .map(record => makeStateRef(project, kind, record)));
}

/**
 * Exact versions return unchanged + record/ref. Omitting revision explicitly
 * requests current data. Historical snapshots are not retained: stale replies
 * expose only currentRecord/currentRef, never record under the requested version.
 */
export function resolveStateReferences(project, references) {
  if (!Array.isArray(references)) throw new TypeError('References must be an array');
  const identity = getStateIdentity(project);
  const resolved = references.map(reference => {
    const entry = { reference };
    if (!isRecord(reference)) return { ...entry, status: 'not_found', reason: 'malformed reference' };
    if (reference.projectId !== identity.projectId || reference.epoch !== identity.epoch) {
      return { ...entry, status: 'scope_mismatch', reason: 'project or epoch mismatch' };
    }
    if (!Object.hasOwn(sections, reference.kind) || !nonempty(reference.id)) {
      return { ...entry, status: 'not_found', reason: 'unsupported kind or missing identity' };
    }
    const exact = Object.hasOwn(reference, 'revision');
    if (exact && (!Number.isSafeInteger(reference.revision) || reference.revision < 0)) {
      return { ...entry, status: 'not_found', reason: 'malformed revision' };
    }
    const matches = (sections[reference.kind](project) ?? []).filter(record =>
      isRecord(record) && recordId(reference.kind, record) === reference.id);
    if (matches.length !== 1) return { ...entry, status: 'not_found', reason: matches.length ? 'ambiguous identity' : 'record unavailable' };
    const record = matches[0], ref = makeStateRef(project, reference.kind, record);
    if (exact && ref.revision !== reference.revision) {
      return { ...entry, status: 'stale', currentRecord: record, currentRef: ref, reason: 'requested version unavailable' };
    }
    return { ...entry, status: exact ? 'unchanged' : 'current', record, ref };
  });
  const needsExpansion = resolved.some(entry => ['stale', 'not_found', 'scope_mismatch'].includes(entry.status));
  return { identity, references: resolved,
    ...(needsExpansion ? { resync: { identity, action: 'Request current references or full context',
      fullContext: { projectId: identity.projectId, detail: 'full' } } } : {}) };
}
