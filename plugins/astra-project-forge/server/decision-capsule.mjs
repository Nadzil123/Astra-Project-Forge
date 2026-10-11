import { recordRevision } from './agent-state.mjs';
import { getCompletionState, getStateIdentity } from './coordination-core.mjs';
import { makeStateRef, listStateRefs, resolveStateReferences } from './state-references.mjs';

function cursorProblem(identity, cursor) {
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
    || typeof cursor.projectId !== 'string' || typeof cursor.epoch !== 'string'
    || !Number.isSafeInteger(cursor.revision) || cursor.revision < 0) return 'malformed cursor';
  if (cursor.projectId !== identity.projectId || cursor.epoch !== identity.epoch) return 'cursor scope mismatch';
  if (cursor.revision > identity.revision) return 'future cursor';
  return null;
}

// Evidence IDs are claim/criterion metadata; refs always use cache record keys.
// Ambiguous metadata preserves all candidate pointers and stays explicit.
function evidenceLinks(project, ids = []) {
  const refs = [], missing = [], ambiguous = [];
  for (const id of new Set(ids)) {
    const matches = (project.efficiency?.evidenceCache ?? []).filter(record => record.evidenceId === id);
    const resolvable = matches.filter(record => typeof record.key === 'string' && record.key.trim());
    if (resolvable.length !== matches.length || !matches.length) missing.push(id);
    if (matches.length > 1) ambiguous.push(id);
    refs.push(...resolvable.map(record => makeStateRef(project, 'evidence', record)));
  }
  return { refs, missing, ambiguous };
}

/**
 * A conservative, heuristic selection of current decision context, supplemented
 * by optional evidence deltas. This is not a semantically lossless replacement
 * for full context; the full-context reader remains directly accessible.
 */
export function buildDecisionCapsule(project, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Capsule options must be an object');
  const identity = getStateIdentity(project);
  const hasCursor = Object.hasOwn(options, 'cursor');
  const problem = hasCursor ? cursorProblem(identity, options.cursor) : null;
  const resync = problem ? { reason: problem, identity, action: 'Discard cursor and request current capsule or full context' } : null;
  const since = hasCursor && !problem ? options.cursor.revision : null;
  const maxItems = Math.min(20, Math.max(1, Number.isInteger(options.maxItems) ? options.maxItems : 5));
  const goals = project.goalGraph ?? [];
  const goal = options.goalId !== undefined
    ? goals.find(record => record.id === options.goalId)
    : goals.find(record => record.status === 'active') ?? goals.find(record => !['verified', 'abandoned'].includes(record.status)) ?? goals[0] ?? null;
  if (options.goalId !== undefined && !goal) throw new Error(`Goal not found: ${options.goalId}`);

  // Keep current claims, requirements and failures even when their stamps predate
  // the cursor. Conservative project-wide inclusion avoids hiding contradictions
  // behind an uncertain relevance heuristic or a small optional-change budget.
  const claims = (project.claims ?? []).map(record => {
    const support = evidenceLinks(project, record.evidenceIds);
    const counter = evidenceLinks(project, record.counterEvidenceIds);
    return { ...record, evidenceRefs: support.refs, counterEvidenceRefs: counter.refs,
      missingEvidenceIds: [...new Set([...support.missing, ...counter.missing])],
      ambiguousEvidenceIds: [...new Set([...support.ambiguous, ...counter.ambiguous])] };
  });
  const completion = getCompletionState(project);
  const risk = completion.risk.map(item => ({ ...item, evidenceRefs: evidenceLinks(project, item.evidenceIds).refs,
    evaluationRef: item.evaluationId === null ? null : makeStateRef(project, 'evaluation',
      project.evaluations.find(record => record.id === item.evaluationId)) }));
  const checkpoint = project.checkpoints?.at(-1);
  const uncertainty = completion.uncertainties.map(item => {
    if (item.checkpointId) return { ...item, ref: makeStateRef(project, 'checkpoint', checkpoint) };
    if (item.hypothesisId) return { ...item, ref: makeStateRef(project, 'hypothesis',
      project.hypotheses.find(record => record.id === item.hypothesisId)) };
    return item;
  });
  const changed = (project.efficiency?.evidenceCache ?? []).filter(record => since === null || recordRevision(record) > since)
    .sort((a, b) => recordRevision(b) - recordRevision(a));
  const changedEvidence = changed.slice(0, maxItems);
  const omittedRefs = changed.slice(maxItems).filter(record => typeof record.key === 'string' && record.key.trim())
    .map(record => makeStateRef(project, 'evidence', record));
  const knownRefs = options.knownRefs ?? [];
  // Capsule callers already know these refs; repeat status/pointers only. Full
  // bodies (including stale currentRecord) belong to explicit getReferences.
  const referenceStatuses = resolveStateReferences(project, knownRefs).references
    .map(({ record, currentRecord, ...metadata }) => metadata);
  const unavailable = referenceStatuses.some(entry => ['stale', 'not_found', 'scope_mismatch'].includes(entry.status));
  const missingEvidence = claims.some(claim => claim.missingEvidenceIds.length || claim.ambiguousEvidenceIds.length);
  const allRefs = listStateRefs(project);
  const mandatory = new Set([
    ...(goal ? [`goal:${goal.id}`] : []),
    ...claims.map(claim => `claim:${claim.id}`),
    ...(project.efficiency?.failedStrategies ?? []).map(record => `failedStrategy:${record.id}`),
    ...completion.missingCriteria.map(record => `goal:${record.goalId}`),
    ...risk.map(item => `plan:${item.planId}`),
    ...risk.filter(item => item.evaluationId).map(item => `evaluation:${item.evaluationId}`),
    ...completion.blockers.filter(item => item.evaluationId).map(item => `evaluation:${item.evaluationId}`),
    ...completion.contradictions.filter(item => item.evaluationId).map(item => `evaluation:${item.evaluationId}`),
    ...uncertainty.filter(item => item.evaluationId).map(item => `evaluation:${item.evaluationId}`),
    ...uncertainty.filter(item => item.hypothesisId).map(item => `hypothesis:${item.hypothesisId}`),
    ...(checkpoint?.remainingUnknowns?.length ? [`checkpoint:${checkpoint.id}`] : []),
    ...claims.flatMap(claim => [...claim.evidenceRefs, ...claim.counterEvidenceRefs]).map(ref => `${ref.kind}:${ref.id}`),
    ...risk.flatMap(item => item.evidenceRefs).map(ref => `${ref.kind}:${ref.id}`),
    ...(project.coordination?.criteria ?? []).flatMap(item => evidenceLinks(project, item.evidenceIds).refs).map(ref => `${ref.kind}:${ref.id}`),
  ]);
  const mandatoryRefs = allRefs.filter(ref => mandatory.has(`${ref.kind}:${ref.id}`));
  const optionalRefs = allRefs.filter(ref => !mandatory.has(`${ref.kind}:${ref.id}`) && ref.kind !== 'evidence'
    && (since === null || ref.revision > since)).sort((a, b) => b.revision - a.revision);
  const recentRefs = optionalRefs.slice(0, Math.max(0, maxItems - changedEvidence.length));
  const historyOmittedCount = optionalRefs.length - recentRefs.length;
  const refs = [...new Map([...mandatoryRefs, ...changedEvidence.filter(record => typeof record.key === 'string' && record.key.trim())
    .map(record => makeStateRef(project, 'evidence', record)), ...omittedRefs, ...recentRefs].map(ref => [`${ref.kind}:${ref.id}`, ref])).values()];
  return {
    identity, goal, constraints: [...(project.constraints ?? []), ...(goal?.constraints ?? [])],
    unmetCriteria: completion.missingCriteria, claims, blockers: completion.blockers,
    uncertainty, risk, failedStrategies: project.efficiency?.failedStrategies ?? [],
    changedEvidence, completion, refs,
    incomplete: Boolean(problem || changed.length > maxItems || historyOmittedCount || unavailable || missingEvidence),
    expansion: { resync, omittedRefs, recentRefs, referenceStatuses, omittedCount: Math.max(0, changed.length - maxItems) + historyOmittedCount,
      selection: 'heuristic', fullContext: { projectId: identity.projectId, detail: 'full' } },
  };
}
