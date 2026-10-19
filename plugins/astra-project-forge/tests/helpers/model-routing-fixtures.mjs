import { makeEvidenceKey } from '../../server/evidence-cache.mjs';
import { normalizeEvidenceRecord } from '../../server/evidence-records.mjs';
import { createAdvisoryHostAdapter } from '../../server/model-host-adapter.mjs';
import { readModelEligibility } from '../../server/model-policy.mjs';

// Synthetic structural assessments, never real model or execution results.
export function routingFixture(patch = {}) {
  const evidence = { ...normalizeEvidenceRecord({ evidenceId: 'check-1', kind: 'test',
    target: 'unit check', dependencies: ['source:v1'], dependencyIds: ['source'],
    freshness: 'fresh', result: { synthetic: true } }), revision: 1 };
  const project = {
    projectId: 'routing-test', revision: 1, schemaVersion: 2,
    goalGraph: [{ id: 'goal-1', revision: 1, status: 'active', dependencies: [],
      successCriteria: ['unit check', 'regression check'] }],
    claims: [], plans: [], evaluations: [], observations: [], checkpoints: [], hypotheses: [],
    coordination: { epoch: 'epoch-1', operations: {}, criteria: [{ goalId: 'goal-1',
      criterion: 'unit check', satisfied: true, evidenceIds: ['check-1'],
      evidenceDigests: { 'check-1': makeEvidenceKey({ params: evidenceContent(evidence) }) },
      criteriaDigest: makeEvidenceKey({ params: ['regression check', 'unit check'] }),
      assessmentSource: 'reported' }] },
    efficiency: { evidenceCache: [evidence], failedStrategies: [] },
    ...patch.project,
  };
  const request = { version: 1, workUnitId: 'work-1', sourceIdentity: 'source:v1',
    currentModel: 'gpt-6.1-sol', userPreference: 'auto', forbiddenModels: [], benefit: null,
    nextHypothesis: null, stableBoundary: false, receiverCanResolveReferences: true,
    operationId: 'route-1', expectedState: { projectId: 'routing-test', epoch: 'epoch-1', revision: 1 },
    ...patch.request };
  const runtime = createAdvisoryHostAdapter(readModelEligibility({
    ASTRA_REQUIRED_MODEL: 'gpt-6-astra', ASTRA_ALLOWED_MODELS: 'gpt-6-astra,gpt-6.1-sol',
  })).describe();
  return { project, request, runtime: { ...runtime, ...patch.runtime } };
}

function evidenceContent({ revision, ...content }) { return content; }

export function supportAllCriteria(project) {
  const assessment = project.coordination.criteria[0];
  project.coordination.criteria = project.goalGraph[0].successCriteria.map(criterion =>
    ({ ...structuredClone(assessment), criterion }));
  return project;
}

export function addDependencyRisk(fixture) {
  fixture.project.plans.push({ id: 'plan-1', revision: 1, goalId: 'goal-1', risk: 'high',
    verificationRisk: 'high', expectedDecisionImpact: 'high', reversible: false,
    action: 'Determine the dependency contract before modifying its consumers',
    strategyKey: 'inspect-contract' });
  fixture.request.benefit = { kind: 'dependency_risk',
    reason: 'Determine which dependency contract keeps consumers correct', refs: [routingRef('plan', 'plan-1')] };
  return fixture;
}

export function addFailure(fixture) {
  fixture.project.plans.push({ id: 'failed-plan', revision: 1, goalId: 'goal-1', risk: 'low',
    verificationRisk: 'low', expectedDecisionImpact: 'low', reversible: true,
    action: 'Run the original parser strategy', strategyKey: 'same-strategy' });
  fixture.project.evaluations.push({ id: 'failed-eval', revision: 1, goalId: 'goal-1',
    planId: 'failed-plan', outcome: 'falsified', missingCriteria: ['regression check'], evidenceIds: [] });
  fixture.project.efficiency.failedStrategies.push({ id: 'failure-1', revision: 1,
    strategyKey: 'same-strategy', status: 'failed', planId: 'failed-plan', evaluationId: 'failed-eval',
    outcome: 'falsified', newEvidenceIds: ['check-1'], changedConditions: 'old parser configuration' });
  return fixture;
}

export function routingRef(kind, id) {
  return { projectId: 'routing-test', epoch: 'epoch-1', kind, id, revision: 1 };
}
