import { latestRecordRevision, recordRevision, stampChangedRecords } from './agent-state.mjs';
import { getStateIdentity } from './coordination-core.mjs';
import { buildDecisionCapsule } from './decision-capsule.mjs';
import { makeEvidenceKey } from './evidence-cache.mjs';
import { buildModelRoutingSnapshot, recommendModel, validateModelRoutingRequest } from './model-router.mjs';
import { makeStateRef, listStateRefs, resolveStateReferences } from './state-references.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const safeRevision = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => makeEvidenceKey({ params: value });
const models = ['gpt-6.1-sol', 'gpt-6-astra'];
const actions = ['COMPLETE', 'KEEP_SOL', 'KEEP_ASTRA', 'SOL_RETRY_WITH_NEW_EVIDENCE',
  'ESCALATE_ASTRA', 'DEFER_ESCALATION', 'REQUEST_USER_CHOICE'];

function validStoredRefs(references, project) {
  return Array.isArray(references) && references.every(reference => {
    if (!object(reference) || typeof reference.kind !== 'string'
      || !['projectId', 'epoch', 'id'].every(key => nonempty(reference[key]))) return false;
    // Validate known reference kinds/revisions without requiring historical records to exist.
    try {
      makeStateRef(project, reference.kind, { id: reference.id, key: reference.id,
        ...(Object.hasOwn(reference, 'revision') ? { revision: reference.revision } : {}) });
      return true;
    } catch { return false; }
  });
}

function validStoredHold(hold, advice, decision, project) {
  return hold === null || object(hold) && models.includes(hold.model) && hold.model === advice.recommendedModel
    && nonempty(hold.workUnitId) && hold.workUnitId === decision.workUnitId
    && nonempty(hold.sourceIdentity) && hold.sourceIdentity === decision.sourceIdentity
    && ['dependency_risk', 'stalled_strategy'].includes(hold.triggerKind)
    && validStoredRefs(hold.triggerRefs, project) && hold.triggerRefs.length > 0;
}

function validStoredAdvice(advice, decision, project) {
  return object(advice) && advice.version === 1 && actions.includes(advice.action) && actions.includes(advice.policyAction)
    && (advice.recommendedModel === null || nonempty(advice.recommendedModel))
    && ['reasonCodes', 'reasons', 'unmetCriteria'].every(key => Array.isArray(advice[key])
      && advice[key].every(item => typeof item === 'string'))
    && validStoredRefs(advice.evidenceRefs, project) && advice.verificationPreserved === true
    && ['reported', 'unknown'].includes(advice.assessmentSource) && advice.advisory === true
    && advice.executionStatus === 'not_attempted' && advice.observedModel === null
    && advice.remainingVerifiedCost === null && advice.calibration === 'not_measured'
    && validStoredHold(advice.hold, advice, decision, project);
}

export function prepareModelRoutingArgs(projectId, args) {
  // Inspect the complete call before any property reads or asynchronous admission.
  digest(args);
  if (!object(args)) throw new TypeError('Routing args must be a JSON object');
  const input = structuredClone(args);
  if (Object.hasOwn(input, 'projectId') && input.projectId !== projectId) {
    throw new TypeError('Routing project identity mismatch');
  }
  input.modelRouting = validateModelRoutingRequest(input.modelRouting, { projectId });
  return input;
}

function validateExtension(extension, project) {
  const identity = getStateIdentity(project);
  if (!object(extension) || extension.version !== 1) throw new TypeError('Unsupported modelRouting extension version');
  if (!Array.isArray(extension.decisions) || !object(extension.operations)) throw new TypeError('Malformed modelRouting extension');
  const byId = new Map();
  for (const decision of extension.decisions) {
    if (!object(decision) || !nonempty(decision.id) || !safeRevision(decision.revision)
      || !nonempty(decision.workUnitId) || !nonempty(decision.sourceIdentity) || !nonempty(decision.policyHash)
      || !validStoredAdvice(decision.advice, decision, project) || byId.has(decision.id)) throw new TypeError('Malformed modelRouting decision');
    byId.set(decision.id, decision);
  }
  if (byId.size !== Object.keys(extension.operations).length) throw new TypeError('Malformed modelRouting receipt/decision mapping');
  for (const [id, receipt] of Object.entries(extension.operations)) {
    const response = receipt?.response;
    const decision = byId.get(id);
    if (!object(receipt) || !nonempty(receipt.digest) || !nonempty(receipt.policyHash)
      || !decision || decision.policyHash !== receipt.policyHash
      || !object(response) || !validStoredAdvice(response.modelAdvice, decision, project) || !object(response.route)
      || typeof response.noticeRequired !== 'boolean' || typeof response.deepNoticeRequired !== 'boolean'
      || response.replayed !== false
      || !object(response.identity) || response.identity.projectId !== identity.projectId
      || response.identity.epoch !== identity.epoch || !safeRevision(response.identity.revision)
      || response.identity.revision !== decision.revision) {
      throw new TypeError('Malformed modelRouting operation receipt');
    }
  }
}

function requestedRefs(advice, request) {
  return [...(advice?.evidenceRefs ?? []), ...(advice?.hold?.triggerRefs ?? []),
    ...(request.benefit?.refs ?? []), ...(request.nextHypothesis?.changedEvidenceRefs ?? [])];
}

export function buildModelHandoff(project, advice, request) {
  const capsule = buildDecisionCapsule(project);
  const refs = listStateRefs(project);
  const snapshot = buildModelRoutingSnapshot(project, request);
  const historicalRefs = snapshot.hold && !snapshot.holdResolutionSupported ? snapshot.hold.triggerRefs : [];
  const requested = [...requestedRefs(advice, request), ...historicalRefs];
  const references = [...new Map([...refs, ...capsule.refs, ...requested]
    .map(ref => [JSON.stringify(ref), ref])).values()];
  const resolved = resolveStateReferences(project, references);
  const incomplete = capsule.incomplete || Boolean(resolved.resync);
  const resync = resolved.resync ?? capsule.expansion.resync ?? (incomplete ? {
    identity: capsule.identity, action: 'Request full context to resync the incomplete capsule',
    fullContext: capsule.expansion.fullContext,
  } : null);
  const statuses = resolved.references.map(({ record, currentRecord, ...metadata }) => metadata);
  const fallback = request.receiverCanResolveReferences ? {} : {
    referenceBodies: resolved.references,
  };
  return structuredClone({
    version: 1, projectId: project.projectId, goalIds: (project.goalGraph ?? []).map(goal => goal.id),
    identity: capsule.identity, epoch: capsule.identity.epoch, revision: capsule.identity.revision,
    sourceIdentity: { value: request.sourceIdentity, source: 'reported' },
    currentModel: { value: request.currentModel, source: 'reported' },
    recommendedModel: { value: advice.recommendedModel, source: 'advisory', executionStatus: 'not_attempted' },
    observedModel: null, workUnitId: request.workUnitId,
    nextAction: incomplete ? 'resync' : advice.nextObservation ?? advice.policyAction,
    unmetCriteria: [...advice.unmetCriteria, ...capsule.unmetCriteria],
    constraints: [...new Set([...(project.constraints ?? []),
      ...(project.goalGraph ?? []).flatMap(goal => goal.constraints ?? [])])],
    claims: capsule.claims, contradictions: capsule.completion.contradictions,
    blockers: capsule.blockers, uncertainty: capsule.uncertainty, risk: capsule.risk,
    failedStrategies: capsule.failedStrategies,
    requiredVerification: (project.goalGraph ?? []).flatMap(goal => (goal.successCriteria ?? [])
      .map(criterion => ({ goalId: goal.id, criterion, sourceIdentity: request.sourceIdentity }))),
    userPolicy: { preference: request.userPreference, forbiddenModels: request.forbiddenModels },
    refs, references: statuses, ...fallback, incomplete, resync,
    expansion: capsule.expansion,
    resumeInstructions: incomplete
      ? 'Resync current references or full context before continuing; unresolved evidence cannot establish completion.'
      : 'Read the current project identity and references, retain constraints and required verification, and reconcile operator policy before acting. Model recommendations do not establish observed execution.',
  });
}

export function routeModelTransition(project, input, runtime, { noCommit }, applyWorkflow) {
  const request = input.modelRouting;
  const identity = getStateIdentity(project);
  if (Object.hasOwn(project, 'modelRouting')) validateExtension(project.modelRouting, project);
  if (request.expectedState.projectId !== identity.projectId || request.expectedState.epoch !== identity.epoch) {
    const error = new Error('Model routing project/epoch identity conflict');
    error.code = 'STATE_EPOCH_CONFLICT';
    error.identity = getStateIdentity(project);
    throw error;
  }
  const { resultLevel, includeContext, hostCapabilities, ...semanticInput } = input;
  const operationDigest = digest(semanticInput);
  const operations = project.modelRouting?.operations;
  if (operations && Object.hasOwn(operations, request.operationId)) {
    const receipt = operations[request.operationId];
    if (receipt.digest !== operationDigest) throw new Error('Operation ID reused with different payload digest');
    // This is a historical receipt, never current policy authorization.
    return noCommit({ ...structuredClone(receipt.response), replayed: true });
  }
  if (request.expectedState.revision !== identity.revision) {
    const error = new Error('Model routing expected revision conflict');
    error.code = 'REVISION_CONFLICT';
    error.identity = getStateIdentity(project);
    throw error;
  }
  const policyHash = digest(runtime);
  const referenceProblems = resolveStateReferences(project, requestedRefs(null, request)).resync;
  const signals = { ...input, ...(referenceProblems ? { importantUncertainty: true } : {}) };
  const snapshot = buildModelRoutingSnapshot(project, request, signals);
  const modelAdvice = recommendModel(snapshot, request, runtime);
  const complete = modelAdvice.policyAction === 'COMPLETE' && modelAdvice.action === 'COMPLETE';
  const previous = structuredClone(project);
  const workflow = applyWorkflow(project, { ...input,
    successCriteriaSatisfied: complete, evidenceSufficient: complete,
    contradictionRemaining: !complete, meaningfulRiskRemaining: !complete,
  });
  const revision = latestRecordRevision(project) + 1;
  recordRevision({ revision });
  const responseProject = structuredClone(project);
  stampChangedRecords(responseProject, previous, revision);
  responseProject.revision = revision;
  const response = { ...workflow, modelAdvice, identity: getStateIdentity(responseProject), replayed: false,
    ...(modelAdvice.action === 'REQUEST_USER_CHOICE' || modelAdvice.action === 'DEFER_ESCALATION'
      ? { modelHandoff: buildModelHandoff(responseProject, modelAdvice, request) } : {}),
  };
  project.modelRouting ??= { version: 1, decisions: [], operations: {} };
  project.modelRouting.decisions.push({ id: request.operationId, revision,
    workUnitId: request.workUnitId, sourceIdentity: request.sourceIdentity, policyHash,
    advice: structuredClone(modelAdvice) });
  Object.defineProperty(project.modelRouting.operations, request.operationId, {
    enumerable: true, writable: true, configurable: true,
    value: { digest: operationDigest, policyHash, response: structuredClone(response) },
  });
  return response;
}
