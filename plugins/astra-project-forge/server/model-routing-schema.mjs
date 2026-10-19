export { validateModelRoutingRequest } from './model-router.mjs';

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const text = { type: 'string', minLength: 1, pattern: '\\S' };
const strings = { type: 'array', items: text };
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const identity = object({ projectId: text, epoch: text, revision });
const reference = object({ projectId: text, epoch: text,
  kind: { type: 'string', enum: ['goal', 'claim', 'plan', 'evaluation', 'evidence', 'observation',
    'failedStrategy', 'checkpoint', 'adaptation', 'transfer', 'lesson', 'hypothesis', 'experiment'] },
  id: text, revision,
}, ['projectId', 'epoch', 'kind', 'id']);
const references = { type: 'array', items: reference };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const fields = {
  version: { type: 'integer', const: 1 },
  workUnitId: text,
  sourceIdentity: { ...text, description: 'Caller-reported source/tree identity, not independently measured.' },
  currentModel: nullable({ ...text, description: 'Reported active model; never trusted host identity.' }),
  userPreference: { type: 'string', enum: ['auto', 'sol', 'astra', 'stay'] },
  forbiddenModels: strings,
  benefit: nullable(object({ kind: { type: 'string', enum: ['dependency_risk', 'stalled_strategy'] },
    reason: text, refs: references })),
  nextHypothesis: nullable(object({ strategyKey: text, changedEvidenceRefs: references,
    changedConditions: strings, discriminatingCheck: text })),
  stableBoundary: { type: 'boolean' },
  receiverCanResolveReferences: { type: 'boolean' },
};

export const modelRoutingSchemaV1 = {
  ...object({ ...fields, operationId: text, expectedState: identity }, Object.keys(fields)),
  description: 'Optional advisory v1 metadata. With projectId, operationId and expectedState are required; without projectId both are forbidden. Eligibility is operator-controlled independently of this extension.',
};
